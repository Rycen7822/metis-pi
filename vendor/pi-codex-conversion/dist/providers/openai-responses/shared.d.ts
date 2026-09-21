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
interface ConvertResponsesMessagesOptions {
    includeSystemPrompt?: boolean | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    deferredTools?: ReadonlyMap<string, Tool> | undefined;
    deferredToolsMode?: "additional-tools" | "tool-search" | undefined;
    /** Placement from `splitDeferredTools`: later system messages declare their additions in place. */
    anchorsToolAdditions?: boolean | undefined;
    /** Model accepts system/developer messages in the middle of the transcript. */
    supportsMidConvoSystemMessages?: boolean | undefined;
    /**
     * Whether `context.messages` starts at the transcript head. Slices that continue a longer
     * transcript pass false so a leading update is replayed in place instead of being dropped
     * as the global prompt.
     */
    startsAtTranscriptHead?: boolean | undefined;
    toolOptions?: ConvertResponsesToolsOptions | undefined;
}
interface ConvertResponsesToolsOptions {
    strict?: boolean | null | undefined;
    supportsStrictMode?: boolean | undefined;
    supportsOpenAIGrammarTools?: boolean | undefined;
    deferLoading?: boolean | undefined;
}
export declare const CODEX_TOOL_CALL_PROVIDERS: Set<string>;
export type ResponsesToolDeclarationMode = "additional-tools" | "tool-search";
/** Model capabilities that decide how a transcript is replayed on the wire. */
export interface ResponsesTranscriptSemantics {
    /** The model accepts system/developer messages between turns. */
    supportsMidConvoSystemMessages: boolean;
    /** How tools declared after the first turn travel; `undefined` when the model has no in-place additions. */
    deferredToolsMode: ResponsesToolDeclarationMode | undefined;
    supportsStrictMode: boolean;
}
/**
 * Read the transcript semantics a model declares. Every provider-facing path (normal request,
 * compaction serializer, native replay) resolves them here, so the same transcript is replayed
 * the same way and no caller re-invents a second, independent decision.
 */
export declare function resolveResponsesTranscriptSemantics(model: Model<Api>): ResponsesTranscriptSemantics;
/**
 * The single tool placement decision for `messages`: which tools the request declares at the top
 * level and which ones its later system messages announce in place. Callers that serialize slices
 * of an already decided transcript pass the result on instead of asking again. Agent-level entries
 * are accepted: the decision only reads system messages and tool declarations.
 */
export declare function resolveToolPlacement<TApi extends Api>(model: Model<TApi>, messages: TranscriptMessages, startsAtTranscriptHead?: boolean): DeferredToolPlacement;
/** Everything a provider-facing path needs to replay one transcript. */
export interface PreparedResponsesTranscript {
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
/**
 * Decide where every current tool is declared: the top-level request field or a later in-place
 * addition. This is the single placement decision for the request — the caller hands it to
 * `convertResponsesMessages`, so the top-level declarations and the in-message additions cannot
 * disagree.
 *
 * Pi 0.86 anchors dynamic tools on system messages (`toolsAdded`); the bundled 3.0.34 transport
 * predates that and used `ToolResultMessage.addedToolNames`. Both shapes are read here so code-mode
 * tool deferral keeps its cache-friendly shape on either host.
 *
 * Removals and same-name redeclarations are not expressible as additions: the request then carries
 * the complete current tool set, and nothing is declared in place (which would duplicate a tool or
 * resurrect a removed one).
 */
export declare function splitDeferredTools(context: Pick<Context, "messages">, enabled: boolean, startsAtTranscriptHead?: boolean): DeferredToolPlacement;
export declare function convertResponsesMessages<TApi extends Api>(model: Model<TApi>, context: Context, allowedToolCallProviders: ReadonlySet<string>, options?: ConvertResponsesMessagesOptions): ResponseInput;
export declare function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[];
export { processResponsesStream } from "./stream.ts";
