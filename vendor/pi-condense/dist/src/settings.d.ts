import type { ContextPruneConfig } from "./types.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export declare function summarizerThinkingLabel(level: ContextPruneConfig["summarizerThinking"]): string;
export declare function batchingModeLabel(mode: ContextPruneConfig["batchingMode"]): string;
export declare function protectedToolsDisplay(list: string[]): string;
export declare function dedupByContentHashDescription(config: ContextPruneConfig): string;
export declare function openPrunerSettings(ctx: ExtensionCommandContext, currentConfig: {
    value: ContextPruneConfig;
}, save: (config: ContextPruneConfig) => Promise<void>, refreshStatus: (config: ContextPruneConfig) => void): Promise<void>;
