import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
import type { ContextPruneConfig } from "./types.js";
/** One owner for local/global rewrite decisions; plain custom entries never enter the prompt. */
export declare function registerOcc(pi: ExtensionAPI, indexer: ToolCallIndexer, config: {
    value: ContextPruneConfig;
}): {
    enabled: () => boolean;
    deferLocal: (ctx: ExtensionContext) => boolean;
    isRunning: () => boolean;
    isCapacityWaiting: () => boolean;
    refreshStatus(ctx: ExtensionContext): void;
    observeRequest(messages: any[]): void;
    measure(ctx: ExtensionContext): any;
    rewrite(ctx: ExtensionContext, before?: number): void;
};
