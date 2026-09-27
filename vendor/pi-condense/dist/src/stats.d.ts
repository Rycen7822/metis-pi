import type { SummarizerStats, LiveReclaim } from "./types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * Usage shape returned by the LLM `complete()` call.
 * Mirrors the `Usage` interface from `@earendil-works/pi-ai` but declared locally
 * so we don't need a runtime import just for the type.
 */
interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
/**
 * Accumulates cumulative token/cost stats for summarizer LLM calls.
 * Stats are persisted to the session via `pi.appendEntry(CUSTOM_TYPE_STATS, ...)`
 * and reconstructed on `session_start` / `session_tree`.
 */
export declare class StatsAccumulator {
    private stats;
    private baseline;
    private liveReclaim;
    /** Add usage data from one summarizer LLM call. */
    add(usage: Usage): void;
    /** Return session-delta spend (current stats minus baseline set at reconstructFromSession). */
    getSessionDelta(): {
        totalCost: number;
        inputTokens: number;
        outputTokens: number;
    };
    /** Store the before/after context-char measurement from the last prune. */
    setLiveReclaim(beforeChars: number, afterChars: number): void;
    /** Return the last live-reclaim measurement, or undefined if none yet. */
    getLiveReclaim(): LiveReclaim | undefined;
    /** Return a snapshot of the current cumulative stats. */
    getStats(): SummarizerStats;
    /** Increment the chain-compression counter. */
    addChainsCompressed(n: number): void;
    /** Increment the fused-range-summary counter. */
    addRangesSummarized(n: number): void;
    /** Reset all accumulated stats to zero. Produces the same state as a fresh accumulator. */
    reset(): void;
    /** Serialize stats for session persistence. */
    toJSON(): SummarizerStats;
    /** Restore stats from a previously persisted snapshot. */
    fromJSON(data: SummarizerStats): void;
    /**
     * Reconstruct stats from session history by scanning all custom entries
     * with customType === CUSTOM_TYPE_STATS.
     */
    reconstructFromSession(ctx: ExtensionContext): void;
    /**
     * Persist current stats to the session.
     * Each call appends a new entry; on reconstructFromSession we scan
     * all entries and apply the LAST one (since each entry is a full snapshot).
     */
    persist(pi: ExtensionAPI): void;
}
/** Format compact counts like Pi's status line (e.g. "1.2k", "340") */
export declare function formatCompactCount(n: number): string;
/** Format token counts like Pi's status line (e.g. "1.2k", "340") */
export declare function formatTokens(n: number): string;
/** Format live char progress like "1.2k summary chars / 8.4k raw chars". */
export declare function formatCharProgress(receivedChars: number, rawChars?: number): string;
/** Format cost like "$0.003" */
export declare function formatCost(n: number): string;
/**
 * Emit the session-delta cost from `accumulator` on EXTERNAL_COST_CHANNEL.
 * Idempotent from the aggregator's perspective: keyed by source, re-emitting overwrites.
 */
export declare function emitExternalCost(pi: ExtensionAPI, accumulator: StatsAccumulator): void;
export {};
