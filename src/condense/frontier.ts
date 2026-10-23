import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { customEntries } from "./custom-entries.ts";
import type { PruneFrontier } from "./types.ts";
import { CUSTOM_TYPE_FRONTIER } from "./types.ts";

/**
 * Tracks a published prune boundary and restores historical outcomes.
 * Current oversized attempts leave a pending gap instead of advancing it.
 */
export class PruneFrontierTracker {
  private frontier: PruneFrontier | null = null;

  reset(): void {
    this.frontier = null;
  }

  get(): PruneFrontier | null {
    return this.frontier ? { ...this.frontier } : null;
  }

  fromJSON(data: PruneFrontier): void {
    if (!data?.lastAttemptedToolCallId) return;
    this.frontier = {
      lastAttemptedToolCallId: data.lastAttemptedToolCallId,
      lastAttemptedResultTimestamp: data.lastAttemptedResultTimestamp,
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

  reconstructFromSession(ctx: ExtensionContext): void {
    this.reset();
    for (const entry of customEntries(ctx.sessionManager.getBranch(), CUSTOM_TYPE_FRONTIER)) {
      const data = entry.data as PruneFrontier;
      if (data) this.fromJSON(data);
    }
  }

  advance(frontier: PruneFrontier): void {
    this.frontier = { ...frontier };
  }

}
