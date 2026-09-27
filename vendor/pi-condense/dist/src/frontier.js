import { CUSTOM_TYPE_FRONTIER } from "./types.js";
/**
 * Tracks the most recent completed prune-attempt boundary.
 *
 * The frontier advances when a prune attempt finishes, regardless of whether it
 * produced a persisted summary or was skipped because the summary was larger
 * than the raw tool outputs. It does not advance on operational failures.
 */
export class PruneFrontierTracker {
    frontier = null;
    reset() {
        this.frontier = null;
    }
    get() {
        return this.frontier ? { ...this.frontier } : null;
    }
    fromJSON(data) {
        if (!data?.lastAttemptedToolCallId)
            return;
        this.frontier = {
            lastAttemptedToolCallId: data.lastAttemptedToolCallId,
            lastAttemptedToolName: data.lastAttemptedToolName ?? "unknown",
            lastAttemptedTurnIndex: data.lastAttemptedTurnIndex ?? 0,
            lastAttemptedTimestamp: data.lastAttemptedTimestamp ?? 0,
            attemptedBatchCount: data.attemptedBatchCount ?? 0,
            attemptedToolCallCount: data.attemptedToolCallCount ?? 0,
            rawCharCount: data.rawCharCount ?? 0,
            summaryCharCount: data.summaryCharCount ?? 0,
            outcome: data.outcome ?? "summarized",
        };
    }
    reconstructFromSession(ctx) {
        this.reset();
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
            if (entry.type === "custom" &&
                entry.customType === CUSTOM_TYPE_FRONTIER) {
                const data = entry.data;
                if (data) {
                    this.fromJSON(data);
                }
            }
        }
    }
    advance(frontier) {
        this.frontier = { ...frontier };
    }
    persist(pi) {
        if (!this.frontier)
            return;
        pi.appendEntry(CUSTOM_TYPE_FRONTIER, this.frontier);
    }
}
