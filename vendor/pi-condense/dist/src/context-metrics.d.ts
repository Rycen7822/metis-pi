import type { ContextMetricsSnapshot, PruneFrontier } from "./types.js";
/**
 * Pure snapshot of what the pruner cannot (yet) reclaim: thinking tokens
 * trapped in the trailing open cycle, the largest single chain's share of
 * the branch, and unsummarized toolResult tokens past the prune frontier.
 */
export declare function computeContextMetrics(branch: any[], frontier: PruneFrontier | null, isSummarized: (occurrenceKey: string) => boolean, isProtected: (toolName: string, args: unknown) => boolean): ContextMetricsSnapshot;
