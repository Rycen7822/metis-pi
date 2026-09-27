import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig, SummarizeBatchOptions, SummarizeBatchesOptions, SummarizeResult } from "./types.js";
export declare function summarizerThinkingOptions(config: ContextPruneConfig): Record<string, unknown>;
/**
 * Returns the model to use for summarization.
 * config.summarizerModel === "default" => ctx.model
 * "provider/model-id" => ctx.modelRegistry.find(provider, modelId), fallback to ctx.model with warning
 */
export declare function resolveModel(config: ContextPruneConfig, ctx: ExtensionContext): any;
/** A summary is usable only if it has non-whitespace text and was not truncated. */
export declare function isUsableSummary(llmText: string, stopReason: string): boolean;
/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
export declare function summarizeBatch(batch: CapturedBatch, config: ContextPruneConfig, ctx: ExtensionContext, options?: SummarizeBatchOptions): Promise<SummarizeResult | null>;
/**
 * Fuses a closed chain's already-computed per-batch summaries into one cohesive
 * range summary (recursive summarization). Input is the span's per-batch summary
 * text — small and already pruned — so this never re-sends raw tool output.
 * Returns the fused text + usage, or null on failure. Used by chain compression
 * to replace the concatenated per-batch body with a single coherent summary.
 */
export declare function summarizeRange(perBatchSummaryText: string, config: ContextPruneConfig, ctx: ExtensionContext, options?: SummarizeBatchOptions): Promise<SummarizeResult | null>;
/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
export declare function summarizeBatches(batches: CapturedBatch[], config: ContextPruneConfig, ctx: ExtensionContext, options?: SummarizeBatchesOptions): Promise<Array<SummarizeResult | null>>;
