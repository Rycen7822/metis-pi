import type { ChainRange, ChainCompressionEntry, ToolCallRecord } from "./types.js";
import type { BlockRefIssuer } from "./block-refs.js";
import type { DiagnosticSink } from "./diagnostics.js";
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
export declare function selectEligible(chains: ChainRange[], rollingWindow: number, alreadyCompressed: Set<number>, inGraceToolCallIds?: Set<string>): ChainRange[];
/**
 * The subset of ToolCallIndexer that compressEligible actually uses.
 * Accepting this narrower interface keeps the function testable without a full indexer
 * and documents its real dependency surface.
 */
export interface ChainCompressorIndexerDeps {
    getChainEntries(): import("./types.js").ChainCompressionEntry[];
    hasPerBatchSummaryCoveringAny(toolCallIds: string[]): boolean;
    getPerBatchSummariesForToolCallIds(toolCallIds: string[]): string[];
    getToolRefsForToolCallIds(toolCallIds: string[]): string[];
    registerChain(entry: import("./types.js").ChainCompressionEntry): void;
    getIndex(): Map<string, ToolCallRecord>;
    backfillChainRecords(records: ToolCallRecord[], opts: {
        spillThreshold: number;
        spillPreviewBytes: number;
        sessionDir: string;
        sessionId: string;
        appendEntry: (customType: string, data?: unknown) => void;
    }): Promise<import("./types.js").SummaryToolCallRef[]>;
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
    backfill: {
        spillThreshold: number;
        spillPreviewBytes: number;
        sessionDir: string;
        sessionId: string;
    };
}
/**
 * Pure span walk backing the deterministic zero-LLM branch. Excludes
 * protected middles (relocated verbatim at render, never phase-1 stubbed)
 * and already-indexed occurrence keys (retry idempotence).
 */
export declare function extractChainRecords(messages: any[], chain: Pick<ChainRange, "startUserTimestamp" | "finalAssistantTimestamp" | "protectedToolCallIds">, isIndexed: (occurrenceKey: string) => boolean): ToolCallRecord[];
/** Deterministic zero-LLM body. Grammar pinned by tests - change both together. */
export declare function buildDeterministicBody(records: ToolCallRecord[], refs: string[]): string;
export interface CompressEligibleResult {
    compressedEntries: ChainCompressionEntry[];
    skipped: Array<{
        startUserTimestamp: number;
        reason: "no-summary" | "already-compressed";
    }>;
}
/**
 * Compresses all chains that are outside the rolling window.
 * Reads existing chain state from the indexer so calls are safe to repeat
 * (already-compressed chains are detected and reported, not double-compressed).
 */
export declare function compressEligible(chains: ChainRange[], rollingWindow: number, deps: CompressEligibleDeps, inGraceToolCallIds?: Set<string>): Promise<CompressEligibleResult>;
