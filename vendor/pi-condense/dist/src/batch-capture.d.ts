import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, BatchingMode } from "./types.js";
/**
 * Unwraps a SessionEntry[] branch into AgentMessage-like objects, including
 * persisted custom_message entries (extension steers) projected as
 * role "custom". Shared by computeMetricsSnapshot, flushPending chain detection,
 * compactChains, and the rescan below so chain anchor timestamps are identical
 * at every site. Projected inline (rather than importing pi-coding-agent's
 * createCustomMessage) because that helper isn't re-exported from the
 * package's "." export map.
 */
export declare function projectBranchMessages(branch: any[]): any[];
/**
 * Session-wide index for the live turn at `turn_end`: the index the rescan
 * below assigns to the branch's last assistant message. Shares the rescan's
 * counting rule (every projected assistant message, text-only included) so
 * live capture and the persisted flush frontier live in one numbering domain.
 * Returns -1 when the branch has no projected assistant message (harness-only;
 * a real `turn_end` always follows a persisted assistant message).
 */
export declare function deriveLiveTurnIndex(branch: SessionEntry[]): number;
/** Joins the text blocks of a ToolResultMessage into a single string. */
export declare function extractToolResultText(msg: any): string;
/**
 * Converts turn_end event data into a CapturedBatch.
 * @param message      AssistantMessage (content: Array of TextContent|ThinkingContent|ToolCall)
 * @param toolResults  ToolResultMessage[]
 */
export declare function captureBatch(message: any, toolResults: any[], turnIndex: number, timestamp: number): CapturedBatch;
/**
 * Scans a session branch for unsummarized tool results and groups them into CapturedBatches.
 * Useful for capturing results from the current in-progress turn when a prune is triggered.
 *
 * @param branch            The session message branch (from ctx.sessionManager.getBranch())
 * @param indexer           The pruner indexer to check for already-summarized IDs
 * @param exclude  Optional predicate; matching tool calls are skipped (user-protected tools/paths)
 */
export declare function captureUnindexedBatchesFromSession(branch: any[], indexer: {
    isSummarized(id: string): boolean;
}, exclude?: (toolName: string, args: unknown) => boolean, sourceTurnIndices?: ReadonlyMap<string, number>): CapturedBatch[];
/** Serializes a single CapturedBatch into readable text for the summarizer LLM. */
export declare function serializeBatchForSummarizer(batch: CapturedBatch): string;
/**
 * Groups CapturedBatches according to the chosen batching mode.
 *
 * - "turn"          : returns the input array unchanged (one summary per assistant turn).
 * - "agent-message" : merges all consecutive batches that share the same `userTurnGroup`
 *                     into a single CapturedBatch, producing one summary per
 *                     user → final-agent-message span.
 *
 * Batches without a `userTurnGroup` (e.g. from the live `turn_end` capture path) are
 * always passed through one-per-batch regardless of mode — grouping only applies to
 * batches captured from the session branch scan.
 *
 * Merge rules:
 *   - `assistantText` = non-empty values joined with "\n\n"
 *   - `toolCalls`     = concatenation in original order
 *   - `turnIndex`     = last batch's turnIndex (latest turn in the group)
 *   - `timestamp`     = last batch's timestamp
 *   - `userTurnGroup` = shared group value of the merged batches
 */
export declare function groupBatchesByMode(batches: CapturedBatch[], mode: BatchingMode): CapturedBatch[];
