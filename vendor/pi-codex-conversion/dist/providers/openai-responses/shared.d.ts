import type { Api, Context, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { ResponseCreateParamsStreaming, ResponseInput, Tool as OpenAITool } from "openai/resources/responses/responses.js";
import { type TranscriptMessages } from "../transcript.ts";
type Message = Context["messages"][number];
export interface OpenAIResponsesStreamOptions {
    serviceTier?: ResponseCreateParamsStreaming["service_tier"] | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    resolveServiceTier?: (responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined, requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => ResponseCreateParamsStreaming["service_tier"] | undefined;
    applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined) => void;
    onOutputItemDone?: (item: unknown) => void;
}
interface ConvertResponsesToolsOptions {
    strict?: boolean | null | undefined;
    supportsStrictMode?: boolean | undefined;
    supportsOpenAIGrammarTools?: boolean | undefined;
    deferLoading?: boolean | undefined;
}
export declare const CODEX_TOOL_CALL_PROVIDERS: Set<string>;
export type ResponsesToolDeclarationMode = "additional-tools" | "tool-search";
/**
 * The single tool placement decision for `messages`: which tools the request declares at the top
 * level and which ones its later system messages announce in place. Callers that serialize slices
 * of an already decided transcript pass the result on instead of asking again. Agent-level entries
 * are accepted: the decision only reads system messages and tool declarations.
 */
export declare function resolveToolPlacement<TApi extends Api>(model: Model<TApi>, messages: TranscriptMessages, startsAtTranscriptHead?: boolean): DeferredToolPlacement;
/** Everything a provider-facing path needs to replay one transcript. */
interface PreparedResponsesTranscript {
    /** Provider input items for the transcript; the leading prompt is not part of it. */
    input: ResponseInput;
    /** Complete text of the leading system message, or `""` when the transcript has none. */
    instructions: string;
    /** Where every current tool is declared; the same decision owns the in-message additions. */
    toolPlacement: DeferredToolPlacement;
    /** Tool conversion options matching the placement. */
    toolOptions: ConvertResponsesToolsOptions;
}
/**
 * Replay one transcript into provider input plus the placement decision that owns every tool
 * declaration. Callers pass `toolPlacement` when they serialize slices of a transcript whose
 * decision was already made (native replay), so no slice decides on its own.
 */
export declare function prepareResponsesTranscript<TApi extends Api>(args: {
    model: Model<TApi>;
    messages: Message[];
    startsAtTranscriptHead?: boolean | undefined;
    toolPlacement?: DeferredToolPlacement | undefined;
    includeSystemPrompt?: boolean | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    allowedToolCallProviders?: ReadonlySet<string> | undefined;
}): PreparedResponsesTranscript;
export interface DeferredToolPlacement {
    /** Tools declared in the top-level request field. */
    immediate: Tool[];
    /** Tools declared in place from a later system message or a pre-0.86 `addedToolNames` result. */
    deferred: Map<string, Tool>;
    /** Whether later system messages declare their own additions in place. */
    anchorsAdditions: boolean;
}
export declare function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[];
export { processResponsesStream } from "./stream.ts";
