import type { Api, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { ResponseCreateParamsStreaming, ResponseInput, Tool as OpenAITool } from "openai/resources/responses/responses.js";
export interface OpenAIResponsesStreamOptions {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"] | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    resolveServiceTier?: (responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined, requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => ResponseCreateParamsStreaming["service_tier"] | undefined;
    applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => void;
    onOutputItemDone?: (item: unknown) => void;
}
interface ConvertResponsesMessagesOptions {
    includeSystemPrompt?: boolean | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    deferredTools?: ReadonlyMap<string, Tool> | undefined;
    deferredToolsMode?: "additional-tools" | "tool-search" | undefined;
    toolOptions?: ConvertResponsesToolsOptions | undefined;
}
interface ConvertResponsesToolsOptions {
    strict?: boolean | null | undefined;
    supportsStrictMode?: boolean | undefined;
    supportsOpenAIGrammarTools?: boolean | undefined;
    deferLoading?: boolean | undefined;
}
export declare const CODEX_TOOL_CALL_PROVIDERS: Set<string>;
export declare function splitDeferredTools(context: Context, enabled: boolean): {
    immediate: Tool[];
    deferred: Map<string, Tool>;
};
export declare function convertResponsesMessages<TApi extends Api>(model: Model<TApi>, context: Context, allowedToolCallProviders: ReadonlySet<string>, options?: ConvertResponsesMessagesOptions): ResponseInput;
export declare function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[];
export { processResponsesStream } from "./stream.ts";
