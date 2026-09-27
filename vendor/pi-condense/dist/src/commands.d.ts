import { type ContextPruneConfig, type SummarizerStats, type LiveReclaim, type CapturedBatch, type ChainCompressionEntry, type FlushOptions, type DiagnosticKind, type ContextMetricsSnapshot } from "./types.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
export declare function pruneStatusText(config: ContextPruneConfig, reclaim?: LiveReclaim, diagnostics?: Record<DiagnosticKind, number>): string;
export declare function setPruneStatusWidget(ctx: {
    ui: {
        setStatus: (id: string, text?: string) => void;
    };
}, config: ContextPruneConfig, value?: LiveReclaim | string, diagnostics?: Record<DiagnosticKind, number>): void;
export declare function registerCommands(pi: ExtensionAPI, currentConfig: {
    value: ContextPruneConfig;
}, flushPending: (ctx: ExtensionCommandContext, options?: FlushOptions) => Promise<{
    ok: true;
    reason: "flushed" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped";
    batchCount: number;
    toolCallCount: number;
    rawCharCount: number;
    summaryCharCount: number;
    dedupedCount?: number;
} | {
    ok: false;
    reason: string;
    error?: string;
}>, capturePendingBatches: (ctx: ExtensionCommandContext) => CapturedBatch[], getStats: () => SummarizerStats, getLiveReclaim: () => LiveReclaim | undefined, indexer: ToolCallIndexer, compactChains: (ctx: ExtensionCommandContext) => Promise<{
    compressedEntries: ChainCompressionEntry[];
    skipped: number;
}>, getDiagnosticCounts?: () => Record<DiagnosticKind, number>, getContextMetrics?: (ctx: ExtensionCommandContext) => ContextMetricsSnapshot, getRearmed?: () => boolean, save?: (config: ContextPruneConfig) => Promise<void>): void;
