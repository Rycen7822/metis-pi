import { type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { ExecutionMode } from "../adapter/activation/execution-mode.ts";
export declare function streamCodeModeResponsesProxy<TApi extends Api>(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): import("@earendil-works/pi-ai").AssistantMessageEventStream;
export interface CodeModeProxyProviderRegistration {
    applyConfig(config: CodexConversionConfig, modelRegistry: CodeModeModelRegistry): void;
    shutdown(): void;
}
type CodeModeModelRegistry = Pick<ModelRegistry, "getAll" | "getProvider" | "getRegisteredProviderConfig">;
export declare function registerCodeModeProxyProvider(pi: ExtensionAPI, getConfig: () => CodexConversionConfig, getExecutionMode?: () => ExecutionMode | undefined, getAvailableToolNames?: () => string[] | undefined): CodeModeProxyProviderRegistration;
export {};
