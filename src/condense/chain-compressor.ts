import { chainMembers, CUSTOM_TYPE_CHAIN } from "./types.ts";
import type { ChainRange, ChainCompressionEntry, SingleChainCompressionEntry, ToolCallRecord } from "./types.ts";
import type { BlockRefIssuer } from "./block-refs.ts";
import type { DiagnosticSink } from "./diagnostics.ts";
import { bareToolCallId, occKey, parseOccKey, resultTimestampOf } from "./occurrence-key.ts";
import { resolveRange } from "./chain-range-prune.ts";
import { projectionFingerprint } from "./token-estimator.ts";
import { setImmediate } from "node:timers/promises";
import type { SharedChainCompressionEntry, SharedChainMember } from "./types.ts";
import { extractToolResultText } from "./batch-capture.ts";

/** Text archives cannot replace incomplete replies or recover tool attachments. */
export function findCompressibleRange(chain: ChainRange, messages: any[]) {
  const range = resolveRange(chain, messages);
  if (!range || ["error", "aborted", "length"].includes(messages[range.endIndex]?.stopReason)) return null;
  const open = new Set<string>();
  for (const message of messages.slice(range.startIndex + 1, range.endIndex)) {
    if (message.role === "assistant") {
      if (open.size) return null;
      for (const block of message.content ?? []) if (block.type === "toolCall") {
        if (open.has(block.id)) return null;
        open.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (!open.delete(message.toolCallId) || message.content?.some((block: any) => block.type !== "text")) return null;
    } else if (open.size) return null;
  }
  if (open.size) return null;
  return range;
}

/**
 * Grace ids are keyed the same way `recovery-grace.ts` keys them: occurrence
 * (`id@timestamp`) when the recovery message carried a timestamp, bare id
 * otherwise. A chain's middles are compared occurrence-first (exact match on
 * `middleOccurrenceKeys`, falling back to `middleToolCallIds` for chains built
 * before the field existed), so a graced occurrence never defers a chain
 * holding a DIFFERENT occurrence of the same reused provider id. The only
 * bare-to-bare fallback is for grace entries that themselves have no
 * timestamp discriminant — there is no exact key to compare in that case.
 */
export function chainMatchesGrace(chain: ChainRange, inGraceToolCallIds: Set<string>): boolean {
  const keys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;
  if (keys.some((k) => inGraceToolCallIds.has(k))) return true;
  for (const g of inGraceToolCallIds) {
    if (parseOccKey(g).resultTimestamp === undefined && keys.some((k) => bareToolCallId(k) === g)) return true;
  }
  return false;
}

/**
 * Pure eligibility filter: given all detected chains, return the subset
 * that should be compressed — closed, not already compressed, and older
 * than the rolling window.
 *
 * Extracted for unit testing without needing a real indexer or appendEntry.
 *
 * @param chains Must be in chronological order (oldest first), as emitted by
 *   chain-detector. Ordering is not validated here; out-of-order input silently
 *   picks wrong chains because the rolling-window slice is positional.
 * @param inGraceToolCallIds Recovery ids still within their grace window. Chains
 *   spanning one of these ids are deferred from compression, but the rolling-window
 *   boundary itself is computed BEFORE grace exclusion, so a grace-protected chain
 *   never shrinks the window buffer or shifts which other chains become eligible.
 */
export function selectEligible(
  chains: ChainRange[],
  rollingWindow: number,
  alreadyCompressed: Set<number>,
  inGraceToolCallIds: Set<string> = new Set(),
): ChainRange[] {
  const candidates = chains.filter(
    (c) =>
      c.finalAssistantTimestamp !== null &&
      !alreadyCompressed.has(c.startUserTimestamp) &&
      c.middleToolCallIds.length > 0,
  );
  const toCompress = candidates.slice(0, Math.max(0, candidates.length - rollingWindow));
  return toCompress.filter((c) => !chainMatchesGrace(c, inGraceToolCallIds));
}

/**
 * The subset of ToolCallIndexer that compressEligible actually uses.
 * Accepting this narrower interface keeps the function testable without a full indexer
 * and documents its real dependency surface.
 */
export interface ChainCompressorIndexerDeps {
  getChainEntries(): import("./types.ts").ChainCompressionEntry[];
  hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
  getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[];
  getToolRefsForToolCallIds(toolCallIds: string[]): string[];
  registerChain(entry: import("./types.ts").ChainCompressionEntry): void;
  getIndex(): Map<string, ToolCallRecord>;
  backfillChainRecords(
    records: ToolCallRecord[],
    opts: {
      spillThreshold: number;
      spillPreviewBytes: number;
      sessionDir: string;
      sessionId: string;
      appendEntry: (customType: string, data?: unknown) => void;
      assertValid?: () => void;
    },
  ): Promise<import("./types.ts").SummaryToolCallRef[]>;
}

export interface CompressEligibleDeps {
  indexer: ChainCompressorIndexerDeps;
  blockRefs: BlockRefIssuer;
  /** pi.appendEntry binding — routes to session or runtime depending on caller context */
  appendEntry: (customType: string, data: unknown) => void;
  /** Injectable clock for deterministic tests */
  now: () => number;
  /**
   * Optional range-summary fuser (B). When present, a span with >= 2 per-batch
   * summaries gets one LLM call fusing them into a cohesive `rangeSummaryText`.
   * Returning null (or throwing) is non-fatal: the chain still compresses and
   * the renderer falls back to the per-batch concatenation.
   */
  fuseRange?: (perBatchSummaryText: string) => Promise<string | null>;
  /** MUST be the same withClosingMessage(...) array chain detection ran on - raw branch messages spuriously fail span resolution on the message_end path (see doc/specs/2026-08-14-uncovered-chain-deterministic-backfill.md). */
  messages: any[];
  diagnostics: Pick<DiagnosticSink, "report">;
  backfill: { spillThreshold: number; spillPreviewBytes: number; sessionDir: string; sessionId: string; assertValid?: () => void };
  validate?: (entry: SingleChainCompressionEntry) => Promise<boolean>;
}

/**
 * Pure span walk backing the deterministic zero-LLM branch. Excludes
 * protected middles (relocated verbatim at render, never phase-1 stubbed)
 * and already-indexed occurrence keys (retry idempotence).
 */
export function extractChainRecords(
  messages: any[],
  chain: Pick<ChainRange, "startUserTimestamp" | "finalAssistantTimestamp" | "protectedToolCallIds">,
  isIndexed: (occurrenceKey: string) => boolean,
): ToolCallRecord[] {
  const range = resolveRange(chain, messages);
  if (!range) return [];
  const protectedIds = new Set(chain.protectedToolCallIds ?? []);
  const open = new Map<string, { toolName: string; args: unknown }>();
  const records: ToolCallRecord[] = [];
  for (let i = range.startIndex + 1; i < range.endIndex; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "toolCall") open.set(block.id, { toolName: block.name, args: block.input ?? block.args ?? block.arguments ?? {} });
      }
    } else if (msg.role === "toolResult") {
      const call = open.get(msg.toolCallId);
      if (!call) continue;
      if (protectedIds.has(msg.toolCallId)) continue;
      const resultTimestamp = resultTimestampOf(msg.timestamp);
      if (resultTimestamp === undefined) continue;
      const key = occKey(msg.toolCallId, resultTimestamp);
      if (isIndexed(key)) continue;
      records.push({
        toolCallId: msg.toolCallId,
        toolName: call.toolName,
        args: call.args as Record<string, unknown>,
        resultText: extractToolResultText(msg),
        isError: msg.isError === true,
        turnIndex: -1, // backfilled records have no batch turn; query tool renders "Turn: -1" (pinned)
        timestamp: resultTimestamp,
        resultTimestamp,
        archiveOnly: true,
      });
    }
  }
  return records;
}

const EXCERPT_CAP = 200;
function excerpt(args: unknown): string {
  const s = JSON.stringify(args) ?? "";
  return s.length <= EXCERPT_CAP ? s : s.slice(0, EXCERPT_CAP) + "...";
}

/** Deterministic zero-LLM body. Grammar pinned by tests - change both together. */
export function buildDeterministicBody(records: ToolCallRecord[], refs: string[]): string {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.toolName, (counts.get(r.toolName) ?? 0) + 1);
  const histogram = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} x${n}`)
    .join(", ");
  const at = (r: ToolCallRecord) => r.resultTimestamp ?? r.timestamp;
  const sorted = [...records].sort((a, b) => at(a) - at(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const seconds = Math.round((at(last) - at(first)) / 1000);
  const refsLine = refs.length > 0 ? refs.join(", ") : records.map((r) => r.toolCallId).join(", ");
  return [
    "Deterministic chain compression (no per-batch summary existed for this span; raw outputs recoverable via context_tree_query).",
    `Calls: ${records.length}`,
    `Tools: ${histogram}`,
    `Span: ${new Date(at(first)).toISOString()} -> ${new Date(at(last)).toISOString()} (${seconds}s)`,
    `First: ${first.toolName} ${excerpt(first.args)}`,
    `Last: ${last.toolName} ${excerpt(last.args)}`,
    `Refs: ${refsLine}`,
  ].join("\n");
}

export interface CompressEligibleResult {
  compressedEntries: ChainCompressionEntry[];
  skipped: Array<{ startUserTimestamp: number; reason: "no-summary" | "already-compressed" | "no-gain" }>;
}

/**
 * Compresses all chains that are outside the rolling window.
 * Reads existing chain state from the indexer so calls are safe to repeat
 * (already-compressed chains are detected and reported, not double-compressed).
 */
export async function compressEligible(
  chains: ChainRange[],
  rollingWindow: number,
  deps: CompressEligibleDeps,
  inGraceToolCallIds: Set<string> = new Set(),
): Promise<CompressEligibleResult> {
  const alreadyCompressedTimestamps = new Set(
    deps.indexer.getChainEntries().flatMap(chainMembers).map((e) => e.startUserTimestamp),
  );

  const skipped: CompressEligibleResult["skipped"] = [];

  // Report already-compressed closed chains for observability.
  for (const chain of chains) {
    if (chain.finalAssistantTimestamp !== null && alreadyCompressedTimestamps.has(chain.startUserTimestamp)) {
      skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "already-compressed" });
    }
  }

  const eligible = selectEligible(chains, rollingWindow, alreadyCompressedTimestamps, inGraceToolCallIds);

  const compressedEntries: ChainCompressionEntry[] = [];
  for (const chain of eligible) {
    // summaryBodies / toolRefs live in occurrence-key space (src/indexer.ts).
    // Bare ids would match nothing and silently skip every chain.
    const lookupKeys = chain.middleOccurrenceKeys?.length ? chain.middleOccurrenceKeys : chain.middleToolCallIds;

    // Small skipped outputs can share a chain with summarized outputs. Archive
    // them before any range drop; archive-only records never authorize stubbing.
    if (deps.indexer.hasPerBatchSummaryCoveringAny(lookupKeys)) {
      const fresh = extractChainRecords(deps.messages, chain, key => deps.indexer.getIndex().has(key));
      try {
        if (fresh.length) await deps.indexer.backfillChainRecords(fresh, { ...deps.backfill, appendEntry: deps.appendEntry });
      } catch {
        skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
        continue;
      }
    }

    if (!deps.indexer.hasPerBatchSummaryCoveringAny(lookupKeys)) {
      // Deterministic zero-LLM fallback (spec 2026-08-14). Fail-closed: any
      // failure below preserves the historical no-summary skip.
      const index = deps.indexer.getIndex();
      const indexed: ToolCallRecord[] = [];
      for (const key of lookupKeys) {
        const r = index.get(key);
        if (r) indexed.push(r);
      }
      const fresh = extractChainRecords(deps.messages, chain, (k) => index.has(k));
      if (fresh.length === 0 && indexed.length === 0) {
        const protectedIds = new Set(chain.protectedToolCallIds ?? []);
        const fullyProtected =
          chain.middleToolCallIds.length > 0 && chain.middleToolCallIds.every((id) => protectedIds.has(id));
        if (!fullyProtected) {
          // Genuine span mismatch - nothing extractable, nothing durable.
          deps.diagnostics.report(
            "backfill-empty",
            String(chain.startUserTimestamp),
            `middles=${chain.middleToolCallIds.length}`,
          );
        }
        skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
        continue;
      }
      try {
        if (fresh.length > 0) {
          await deps.indexer.backfillChainRecords(fresh, { ...deps.backfill, appendEntry: deps.appendEntry });
        }
      } catch {
        skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-summary" });
        continue;
      }
      const allRecords = [...indexed, ...fresh];
      const toolRefs = deps.indexer.getToolRefsForToolCallIds(lookupKeys);
      const entry: SingleChainCompressionEntry = {
        summaryFingerprint: projectionFingerprint([[]]),
        blockId: deps.blockRefs.issue(),
        startUserTimestamp: chain.startUserTimestamp,
        droppedToolCallIds: chain.middleToolCallIds,
        finalAssistantTimestamp: chain.finalAssistantTimestamp,
        toolRefs,
        compressedAt: deps.now(),
        rangeSummaryText: buildDeterministicBody(allRecords, toolRefs),
        bodySource: "deterministic",
        ...(chain.protectedToolCallIds?.length ? { protectedToolCallIds: chain.protectedToolCallIds } : {}),
        ...(chain.middleOccurrenceKeys?.length ? { droppedOccurrenceKeys: chain.middleOccurrenceKeys } : {}),
      };
      if (deps.validate && !await deps.validate(entry)) { skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-gain" }); continue; }
      deps.appendEntry(CUSTOM_TYPE_CHAIN, entry);
      deps.indexer.registerChain(entry);
      compressedEntries.push(entry);
      continue;
    }

    const blockId = deps.blockRefs.issue();
    const toolRefs = deps.indexer.getToolRefsForToolCallIds(lookupKeys);
    const uncovered = lookupKeys.map(key => deps.indexer.getIndex().get(key)).filter((record): record is ToolCallRecord => record?.archiveOnly === true);
    const extraBody = uncovered.length ? buildDeterministicBody(uncovered, deps.indexer.getToolRefsForToolCallIds(
      uncovered.map(record => occKey(record.toolCallId, record.resultTimestamp)))) : undefined;
    const summaries = deps.indexer.getPerBatchSummariesForToolCallIds(lookupKeys);
    const summaryFingerprint = projectionFingerprint([summaries]);

    // B: fuse this span's per-batch summaries into one cohesive summary.
    // Gated on >= 2 summaries (nothing to fuse otherwise). Non-fatal.
    let rangeSummaryText = extraBody ? [...summaries, extraBody].join("\n\n") : undefined;
    if (deps.fuseRange) {
      if (summaries.length >= 2) {
        try {
          const fused = await deps.fuseRange(summaries.join("\n\n"));
          if (fused && fused.trim()) rangeSummaryText = extraBody ? `${fused}\n\n${extraBody}` : fused;
        } catch {
          // fall back to the per-batch concatenation at render time
        }
      }
    }

    const entry: SingleChainCompressionEntry = {
      summaryFingerprint,
      blockId,
      startUserTimestamp: chain.startUserTimestamp,
      droppedToolCallIds: chain.middleToolCallIds,
      finalAssistantTimestamp: chain.finalAssistantTimestamp,
      toolRefs,
      compressedAt: deps.now(),
      ...(rangeSummaryText ? { rangeSummaryText } : {}),
      ...(chain.protectedToolCallIds?.length ? { protectedToolCallIds: chain.protectedToolCallIds } : {}),
      ...(chain.middleOccurrenceKeys?.length ? { droppedOccurrenceKeys: chain.middleOccurrenceKeys } : {}),
    };

    if (deps.validate && !await deps.validate(entry)) { skipped.push({ startUserTimestamp: chain.startUserTimestamp, reason: "no-gain" }); continue; }
    deps.appendEntry(CUSTOM_TYPE_CHAIN, entry);
    deps.indexer.registerChain(entry);
    compressedEntries.push(entry);
  }

  return { compressedEntries, skipped };
}

/** Prepare recoverable, independently owned members. No model call or publish. */
export async function prepareSharedChain(
  chains: ChainRange[], rollingWindow: number,
  deps: CompressEligibleDeps & { indexer: ChainCompressorIndexerDeps & { getOwnedSummaryText(keys: string[]): string | null } },
  anchorId: (role: "start" | "final", timestamp: number) => string | undefined,
  inGrace: Set<string>, signal: AbortSignal,
): Promise<SharedChainCompressionEntry | null> {
  const compressed = new Set(deps.indexer.getChainEntries().flatMap(chainMembers).map(member => member.startUserTimestamp));
  const eligible = selectEligible(chains, rollingWindow, compressed, inGrace);
  const members: SharedChainMember[] = [];
  let bodyText = "";
  for (const chain of eligible) {
    await setImmediate(); signal.throwIfAborted();
    const range = findCompressibleRange(chain, deps.messages);
    if (!range || chain.finalAssistantTimestamp === null) continue;
    const startEntryId = anchorId("start", chain.startUserTimestamp);
    const finalEntryId = anchorId("final", chain.finalAssistantTimestamp);
    if (!startEntryId || !finalEntryId) continue;
    const source = deps.messages.slice(range.startIndex, range.endIndex + 1);
    const final = source.at(-1);
    const keys = chain.middleOccurrenceKeys ?? [];
    if (!keys.length || keys.length !== source.filter(m => m.role === "toolResult").length) continue;
    const calls = source.flatMap(m => m.role === "assistant" ? (m.content ?? []).filter((b: any) => b.type === "toolCall") : []);
    if (calls.length !== keys.length) continue;
    const owned = deps.indexer.getOwnedSummaryText(keys);
    if (owned === null) continue;
    const fresh = extractChainRecords(deps.messages, { ...chain, protectedToolCallIds: [] }, key => deps.indexer.getIndex().has(key));
    if (fresh.length) await deps.indexer.backfillChainRecords(fresh, { ...deps.backfill, appendEntry: deps.appendEntry,
      assertValid: () => { signal.throwIfAborted(); deps.backfill.assertValid?.(); } });
    signal.throwIfAborted();
    const records = keys.map(key => deps.indexer.getIndex().get(key));
    if (records.some(record => !record || record.metadataUnavailable || record.archiveComplete === false)) continue;
    const uncovered = records.filter((record): record is ToolCallRecord => !!record && (!owned || record.archiveOnly === true));
    const facts = uncovered.length ? uncovered.map(record => {
      const status = record.isError ? "ERROR" : "completed";
      return `${record.toolName} ${excerpt(record.args)}: ${status}`;
    }).join("\n") : "";
    const body = [owned, facts].filter(Boolean).join("\n\n");
    if (!body) continue;
    const bodyStart = bodyText.length;
    bodyText += body;
    members.push({ startEntryId, finalEntryId, sourceFingerprint: projectionFingerprint(source),
      startUserTimestamp: chain.startUserTimestamp, finalAssistantTimestamp: chain.finalAssistantTimestamp,
      droppedToolCallIds: chain.middleToolCallIds, droppedOccurrenceKeys: keys,
      protectedToolCallIds: chain.protectedToolCallIds, toolRefs: deps.indexer.getToolRefsForToolCallIds(keys),
      bodyStart, bodyEnd: bodyText.length });
  }
  return members.length < 2 ? null : { kind: "shared-v1", blockId: deps.blockRefs.issue(),
    compressedAt: deps.now(), bodyText, members };
}
