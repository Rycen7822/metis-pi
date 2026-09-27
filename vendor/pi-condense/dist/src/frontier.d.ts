import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PruneFrontier } from "./types.js";
/**
 * Tracks the most recent completed prune-attempt boundary.
 *
 * The frontier advances when a prune attempt finishes, regardless of whether it
 * produced a persisted summary or was skipped because the summary was larger
 * than the raw tool outputs. It does not advance on operational failures.
 */
export declare class PruneFrontierTracker {
    private frontier;
    reset(): void;
    get(): PruneFrontier | null;
    fromJSON(data: PruneFrontier): void;
    reconstructFromSession(ctx: ExtensionContext): void;
    advance(frontier: PruneFrontier): void;
    persist(pi: ExtensionAPI): void;
}
