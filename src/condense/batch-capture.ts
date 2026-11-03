import { captureFusionResult } from "./fusion.ts";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { readHistoryEntries, type SessionEntryReference } from "../session-history.ts";
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
export function deriveLiveTurnIndex(branch: readonly SessionEntryReference[]): number {
  let count = 0;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message?.role === "assistant") count++;
  }
  return count - 1;
}

/** Complete message history for raw evidence and chain logic, excluding unrelated extension payloads. */
export function readMessageBranch(manager: ExtensionContext["sessionManager"]): SessionEntry[] {
  return [...readHistoryEntries(manager, "branch", entry => entry.type === "message" || entry.type === "custom_message")];
}

function isProjectableEntry(e: any): boolean {
  return (e.type === "message" && e.message) || e.type === "custom_message";
}

function projectCustomMessageEntry(e: any): any {
  return {
    role: "custom",
    customType: e.customType,
    content: e.content,
    display: e.display,
    details: e.details,
    timestamp: new Date(e.timestamp).getTime(),
  };
}

export function extractToolResultText(msg: any): string {
  const content: any[] = Array.isArray(msg?.content) ? msg.content : [];
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

export function captureToolResult(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  match: any,
): CapturedToolCall {
  const resultTimestamp = match ? resultTimestampOf(match.timestamp) : undefined;
  return {
    toolCallId,
    toolName,
    args,
    resultText: match ? extractToolResultText(match) : "(no result)",
    isError: (match?.isError ?? false) || match?.details?.metisNested?.hasError === true,
    ...(hasProtectedNestedResults(match?.details)
      ? { nestedProtected: true, nestedRootToolCallId: match?.details?.cellParentToolCallId ?? toolCallId }
      : {}),
    ...(toolName === "exec_command" && typeof match?.details?.exit_code === "number"
      ? { exitCode: match.details.exit_code }
      : {}),
    ...(["bash", "exec_command", "write_stdin"].includes(toolName) && typeof match?.details?.fullOutputPath === "string"
      ? {
          outputArchive: {
            path: match.details.fullOutputPath,
            ...(typeof match.details.fullOutputBytes === "number" ? { bytes: match.details.fullOutputBytes } : {}),
            complete: match.details.fullOutputComplete !== false,
            appendOnly: match.details.fullOutputAppendOnly === true,
          },
        }
      : {}),
    ...(resultTimestamp !== undefined ? { resultTimestamp } : {}),
    ...captureFusionResult(match),
  };
}

export function captureBatch(
  message: any,
  toolResults: any[],
  turnIndex: number,
  timestamp: number
): CapturedBatch {
  const content: any[] = Array.isArray(message?.content) ? message.content : [];

  const assistantText = content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n")
    .trim();

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
 * Consumes the source once and retains only the current assistant's result interval.
 * Useful for capturing results from the current in-progress turn when a prune is triggered.
 *
 * @param branch            The session message branch (from ctx.sessionManager.getBranch())
 * @param indexer           The pruner indexer to check for already-summarized IDs
 * @param exclude  Optional predicate; matching tool calls are skipped (user-protected tools/paths)
 */
export function captureUnindexedBatchesFromSession(
  branch: Iterable<any>,
  indexer: { isSummarized(id: string): boolean },
  exclude?: (toolName: string, args: unknown) => boolean,
  sourceTurnIndices?: ReadonlyMap<string, number>,
): CapturedBatch[] {
  const batches: CapturedBatch[] = [];
  // Every assistant counts, including text-only: this is the persisted frontier's numbering domain.
  let turnCounter = 0;
  // Shared by agent-message grouping; custom chain anchors advance it just like user messages.
  let userTurnGroup = 0;
  let currentTurn: { entry: any; msg: any; turnIndex: number; userTurnGroup: number } | undefined;
  const turnResults = new Map<string, any>();

  const finishTurn = () => {
    if (!currentTurn) return;
    const { entry, msg, turnIndex, userTurnGroup } = currentTurn;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const ready = content.filter((call: any) => {
      if (call.type !== "toolCall" || !call.id) return false;
      const result = turnResults.get(call.id);
      if (!result) return false;
      if (hasProtectedNestedResults(result.details) && exclude) return false;
      if (indexer.isSummarized(occKey(call.id, resultTimestampOf(result.timestamp)))) return false;
      return !exclude?.(call.name, call.input ?? call.arguments);
    });
    if (ready.length === 0) return;
    const results = ready.map((call: any) => turnResults.get(call.id));
    const readyIds = new Set(ready.map((call: any) => call.id));
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : (msg.timestamp ?? Date.now());
    const batch = captureBatch(msg, results, turnIndex, timestamp);
    batches.push({ ...batch, toolCalls: batch.toolCalls.filter(call => readyIds.has(call.toolCallId)), userTurnGroup });
  };

  for (const entry of branch) {
    if (!isProjectableEntry(entry)) continue;
    const msg = entry.type === "custom_message" ? projectCustomMessageEntry(entry) : entry.message;
    // A result belongs to the preceding assistant until the next assistant,
    // even when a user/custom anchor appears between them. Save that turn's group.
    if (msg.role === "assistant") {
      finishTurn();
      turnResults.clear();
      const fallback = turnCounter++;
      currentTurn = { entry, msg, turnIndex: sourceTurnIndices?.get(entry.id) ?? fallback, userTurnGroup };
    } else {
      if (msg.role === "user" || isChainAnchorCustom(msg)) userTurnGroup++;
      if (currentTurn && msg.role === "toolResult" && msg.toolCallId && !turnResults.has(msg.toolCallId)) {
        turnResults.set(msg.toolCallId, msg);
      }
    }
  }
  finishTurn();
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
