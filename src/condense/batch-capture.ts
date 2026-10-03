import { captureFusionResult } from "./fusion.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, CapturedToolCall, BatchingMode } from "./types.ts";
import { occKey, resultTimestampOf } from "./occurrence-key.ts";
import { isChainAnchorCustom } from "./chain-detector.ts";
import { hasProtectedNestedResults } from "./protected.ts";
import { prepareBatch } from "./packing.ts";

/**
 * Unwraps a SessionEntry[] branch into AgentMessage-like objects, including
 * persisted custom_message entries (extension steers) projected as
 * role "custom". Shared by computeMetricsSnapshot, flushPending chain detection,
 * compactChains, and the rescan below so chain anchor timestamps are identical
 * at every site. Projected inline (rather than importing pi-coding-agent's
 * createCustomMessage) because that helper isn't re-exported from the
 * package's "." export map.
 */
export function projectBranchMessages(branch: any[]): any[] {
  return branch
    .filter(isProjectableEntry)
    .map((e: any) => (e.type === "custom_message" ? projectCustomMessageEntry(e) : e.message));
}

/**
 * Session-wide index for the live turn at `turn_end`: the index the rescan
 * below assigns to the branch's last assistant message. Shares the rescan's
 * counting rule (every projected assistant message, text-only included) so
 * live capture and the persisted flush frontier live in one numbering domain.
 * Returns -1 when the branch has no projected assistant message (harness-only;
 * a real `turn_end` always follows a persisted assistant message).
 */
export function deriveLiveTurnIndex(branch: SessionEntry[]): number {
  let count = 0;
  for (const msg of projectBranchMessages(branch)) {
    if (msg.role === "assistant") count++;
  }
  return count - 1;
}

/** True for SessionEntry shapes that project into an AgentMessage-like object (see projectBranchMessages). */
function isProjectableEntry(e: any): boolean {
  return (e.type === "message" && e.message) || e.type === "custom_message";
}

/** Projects a single custom_message SessionEntry into its role "custom" message shape. */
function projectCustomMessageEntry(e: any): any {
  return { role: "custom", customType: e.customType, content: e.content, display: e.display, details: e.details, timestamp: new Date(e.timestamp).getTime() };
}

/** Joins the text blocks of a ToolResultMessage into a single string. */
export function extractToolResultText(msg: any): string {
  const content: any[] = Array.isArray(msg?.content) ? msg.content : [];
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

export function captureToolResult(toolCallId: string, toolName: string, args: Record<string, unknown>, match: any): CapturedToolCall {
  const resultTimestamp = match ? resultTimestampOf(match.timestamp) : undefined;
  return {
    toolCallId, toolName, args, resultText: match ? extractToolResultText(match) : "(no result)",
    isError: (match?.isError ?? false) || match?.details?.metisNested?.hasError === true,
    ...(hasProtectedNestedResults(match?.details) ? { nestedProtected: true, nestedRootToolCallId: match?.details?.cellParentToolCallId ?? toolCallId } : {}),
    ...(toolName === "exec_command" && typeof match?.details?.exit_code === "number" ? { exitCode: match.details.exit_code } : {}),
    ...(["bash", "exec_command", "write_stdin"].includes(toolName) && typeof match?.details?.fullOutputPath === "string"
      ? { outputArchive: { path: match.details.fullOutputPath,
          ...(typeof match.details.fullOutputBytes === "number" ? { bytes: match.details.fullOutputBytes } : {}),
          complete: match.details.fullOutputComplete !== false, appendOnly: match.details.fullOutputAppendOnly === true } } : {}),
    ...(resultTimestamp !== undefined ? { resultTimestamp } : {}),
    ...captureFusionResult(match),
  };
}

/**
 * Converts turn_end event data into a CapturedBatch.
 * @param message      AssistantMessage (content: Array of TextContent|ThinkingContent|ToolCall)
 * @param toolResults  ToolResultMessage[]
 */
export function captureBatch(
  message: any,
  toolResults: any[],
  turnIndex: number,
  timestamp: number
): CapturedBatch {
  const content: any[] = Array.isArray(message?.content) ? message.content : [];

  // Collect assistant prose text
  const assistantText = content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

  // Collect tool calls, matching each to its result
  const toolCalls: CapturedToolCall[] = content
    .filter((block: any) => block.type === "toolCall")
    .map((block: any) => {
      const match = toolResults.find((result: any) => result.toolCallId === block.id);

      return captureToolResult(block.id, block.name, block.input ?? block.args ?? block.arguments ?? {}, match);
    });

  return { turnIndex, timestamp, assistantText, toolCalls };
}

/**
 * Scans a session branch for unsummarized tool results and groups them into CapturedBatches.
 * Useful for capturing results from the current in-progress turn when a prune is triggered.
 *
 * @param branch            The session message branch (from ctx.sessionManager.getBranch())
 * @param indexer           The pruner indexer to check for already-summarized IDs
 * @param exclude  Optional predicate; matching tool calls are skipped (user-protected tools/paths)
 */
export function captureUnindexedBatchesFromSession(
  branch: any[],
  indexer: { isSummarized(id: string): boolean },
  exclude?: (toolName: string, args: unknown) => boolean,
  sourceTurnIndices?: ReadonlyMap<string, number>,
): CapturedBatch[] {
  // Keep the SessionEntry wrapper alongside each projected message so the
  // entry's own timestamp remains available as the preferred source below
  // (projection alone loses that wrapper for "message" entries).
  const projected = branch
    .filter(isProjectableEntry)
    .map((e: any) => ({ entry: e, msg: e.type === "custom_message" ? projectCustomMessageEntry(e) : e.message }));
  const msgs = projected.map((p) => p.msg);

  const batches: CapturedBatch[] = [];
  // turnCounter increments for EVERY assistant message (not just prunable ones).
  // This makes turnIndex stable across multiple prune cycles: pruning removes
  // ToolResultMessages from the context event but leaves AssistantMessages in the
  // session branch, so the count of all assistant messages never decreases. This
  // session-wide count is the frontier's numbering domain; Pi's event.turnIndex
  // matches it only inside one agent run (it resets on agent_start), so the live
  // capture path derives the same index from the branch via deriveLiveTurnIndex.
  let turnCounter = 0;

  // userTurnGroup increments on every user message or eligible custom anchor seen
  // while walking the branch. All assistant tool-call batches between two
  // consecutive boundaries share the same userTurnGroup. This is used by
  // groupBatchesByMode to merge turns within a single user → final-agent-message
  // span when batchingMode === "agent-message".
  let userTurnGroup = 0;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    // Advance userTurnGroup on every user message or eligible custom anchor so
    // all subsequent assistant batches get a new group number.
    if (msg.role === "user" || isChainAnchorCustom(msg)) {
      userTurnGroup++;
      continue;
    }

    if (msg.role !== "assistant") continue;

    // Stable turn index: count every assistant message regardless of pruning state
    const fallbackTurnIndex = turnCounter++;
    const currentTurnIndex = sourceTurnIndices?.get(projected[i].entry.id) ?? fallbackTurnIndex;

    // Per-turn result map: only the results between this assistant message and
    // the next one. A branch-wide map is last-wins and mis-pairs repeated ids.
    const turnResults = new Map<string, any>();
    for (let j = i + 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (m.role === "assistant") break;
      if (m.role === "toolResult" && m.toolCallId && !turnResults.has(m.toolCallId)) {
        turnResults.set(m.toolCallId, m);
      }
    }

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolCallBlocks = content.filter((c: any) => c.type === "toolCall");

    // Find tool calls that have results in this branch and are not yet summarized
    const readyToPrune = toolCallBlocks.filter((tc: any) => {
      const id = tc.id;
      if (!id) return false;
      const result = turnResults.get(id);
      if (!result) return false;
      if (hasProtectedNestedResults(result.details) && exclude) return false;
      if (indexer.isSummarized(occKey(id, resultTimestampOf(result.timestamp)))) return false;
      if (exclude?.(tc.name, tc.input ?? tc.arguments)) return false;
      return true;
    });

    if (readyToPrune.length > 0) {
      const results = readyToPrune.map((tc: any) => turnResults.get(tc.id));
      const readyIds = new Set(readyToPrune.map((tc: any) => tc.id));
      // We pass the full message but then trim back down to only the tool calls
      // whose results already exist in the session. This lets a flush prune
      // an intermediate completed subset in the middle of a longer tool chain
      // without accidentally capturing later unresolved calls from the same
      // assistant message as "(no result)" placeholders.
      const entryTimestamp = projected[i].entry.timestamp;
      const ts = entryTimestamp ? new Date(entryTimestamp).getTime() : (msg.timestamp ?? Date.now());
      const batch = captureBatch(msg, results, currentTurnIndex, ts);
      batches.push({
        ...batch,
        toolCalls: batch.toolCalls.filter((tc) => readyIds.has(tc.toolCallId)),
        // Tag with the current group so flushPending can merge by mode
        userTurnGroup,
      });
    }
  }

  return batches;
}

// One budget covers the complete batch. The system prompt is small and separate.
export const SUMMARY_INPUT_CHARS = 65536;

/** Bounded original excerpts; never silently turn partial evidence into a full result. */
function excerpt(text: string, budget: number, diagnostics = false): string {
  if (text.length <= budget) return text;
  const marker = "\n[Original text omitted; recover the full occurrence with context_tree_query.]\n";
  if (budget < 2 * marker.length) return marker;
  const room = Math.max(0, budget - 2 * marker.length);
  let selected = "";
  if (diagnostics) {
    for (const line of text.split("\n")) {
      if (/\b(error|fail(?:ed|ure|ures)?|warning|panic|exception|traceback|assert(?:ion)?|passed)\b/i.test(line)
        && selected.length + line.length + 1 <= room / 3) selected += line + "\n";
    }
  }
  const headEnd = Math.floor((room - selected.length) / 2);
  const tailStart = text.length - (room - selected.length - headEnd);
  // Keep UTF-16 surrogate pairs intact; the output is later encoded as UTF-8.
  const head = text.slice(0, headEnd).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(tailStart).replace(/^[\uDC00-\uDFFF]/, "");
  return head + marker + selected + marker + tail;
}

/** Undefined means the batch identities themselves cannot safely fit the input budget. */
export function serializeBatchForSummarizer(batch: CapturedBatch, inputChars = SUMMARY_INPUT_CHARS): string | undefined {
  const parts: string[] = [];
  if (batch.assistantText) parts.push(`Assistant said: ${excerpt(batch.assistantText, Math.min(2048, Math.floor(inputChars / 8)))}\n`);
  let remaining = inputChars - parts.join("").length;
  for (const [index, tc] of batch.toolCalls.entries()) {
    const header = `[[${index + 1}:${tc.toolName}]] Tool: ${tc.toolName}\nArguments (historical JSON):\n`;
    const resultHeader = `\nResult (${tc.isError ? "ERROR" : "OK"}; excerpts are explicitly marked):\n`;
    const quota = Math.floor(remaining / (batch.toolCalls.length - index)) - header.length - resultHeader.length - 5;
    if (quota < 512) return undefined;
    const originalArgs = JSON.stringify(tc.args, null, 2);
    // Split multi-call batches instead of silently losing command conditions.
    // A single oversized call still uses explicitly marked recoverable excerpts.
    if (batch.toolCalls.length > 1 && originalArgs.length > quota - 512) return undefined;
    const args = excerpt(originalArgs, Math.max(0, quota - 512));
    const result = excerpt(tc.resultText, quota - args.length, true);
    const part = header + args + resultHeader + result;
    parts.push(part);
    remaining -= part.length + 5;
  }
  const serialized = parts.join("\n---\n");
  return serialized.length <= inputChars ? serialized : undefined;
}

/**
 * Plan budget-bounded chunks; only agent-message merges adjacent user-group turns.
 * Preserve occurrence order and each chunk's last source turn, including retries.
 * A single call that cannot fit is retained for an explicit local budget failure.
 */
export function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode, inputChars = SUMMARY_INPUT_CHARS): CapturedBatch[] {
  const out: CapturedBatch[] = [];
  for (const batch of batches) {
    if (!batch.toolCalls.length) {
      out.push(batch);
      continue;
    }
    for (const call of batch.toolCalls) {
      // Retain original turn metadata when a restored chunk is planned again.
      const sourceTurn = call.sourceTurn ?? { turnIndex: batch.turnIndex, timestamp: batch.timestamp };
      const tc = { ...call, sourceTurn };
      const current = out.at(-1);
      const sameTurn = current?.turnIndex === sourceTurn.turnIndex && current.timestamp === sourceTurn.timestamp;
      const sameGroup = mode === "agent-message" && batch.userTurnGroup !== undefined
        && current?.userTurnGroup === batch.userTurnGroup;
      const candidate = current && current.toolCalls.length && (sameTurn || sameGroup) ? {
        ...batch, ...sourceTurn,
        assistantText: sameTurn ? current.assistantText : [current.assistantText, batch.assistantText].filter(Boolean).join("\n\n"),
        toolCalls: [...current.toolCalls, tc],
      } : undefined;
      // A full user request can contain dozens of tool steps. Limit one model's
      // work so the three-request window can actually shorten final-reply waits.
      if (candidate && candidate.toolCalls.length <= 24 && serializeBatchForSummarizer(prepareBatch(candidate).candidate, inputChars) !== undefined) {
        out[out.length - 1] = candidate;
      } else {
        out.push({ ...batch, ...sourceTurn, toolCalls: [tc] });
      }
    }
  }
  return out;
}
