import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type DeferredToolPlacement } from "../../providers/openai-responses/shared.ts";
/**
 * Responses compaction reuses the provider's serializer.
 *
 * Replay parity must match the actual OpenAI Codex provider payload, including
 * tool-call id normalization and cross-model/provider history handling.
 */
export type AssistantPhase = "commentary" | "final_answer";
type ResponsesTextInputItem = {
    type: "input_text";
    text: string;
};
type ResponsesImageInputItem = {
    type: "input_image";
    detail: "auto" | "high" | "original";
    image_url: string;
};
type ResponsesEncryptedContentItem = {
    type: "encrypted_content";
    encrypted_content: string;
};
export type ResponsesInputContentItem = ResponsesTextInputItem | ResponsesImageInputItem | ResponsesEncryptedContentItem;
export type ResponsesInputMessageItem = {
    role: "user" | "developer" | "system";
    content: ResponsesInputContentItem[] | string;
};
export type ResponsesAssistantOutputItem = {
    type: "message";
    role: "assistant";
    content: Array<{
        type: "output_text";
        text: string;
        annotations: [];
    }>;
    status: "completed";
    id: string;
    phase?: AssistantPhase | undefined;
};
export type ResponsesFunctionCallItem = {
    type: "function_call";
    id?: string | undefined;
    call_id: string;
    name: string;
    arguments: string;
};
export type ResponsesFunctionCallOutputItem = {
    type: "function_call_output";
    call_id: string;
    output: ResponsesInputContentItem[] | string;
};
export type ResponsesReasoningItem = Record<string, unknown>;
export type ResponsesInputItem = ResponsesInputMessageItem | ResponsesAssistantOutputItem | ResponsesFunctionCallItem | ResponsesFunctionCallOutputItem | ResponsesReasoningItem;
export type NativeCompactionRequestBody = {
    model: string;
    input: ResponsesInputItem[];
    instructions?: string | undefined;
    parallel_tool_calls?: boolean | undefined;
    prompt_cache_key?: string | undefined;
    service_tier?: string | undefined;
    text?: {
        verbosity: string;
    } | undefined;
    reasoning?: unknown | undefined;
};
export type NativeCompactionRequestOptions = Pick<NativeCompactionRequestBody, "parallel_tool_calls" | "prompt_cache_key" | "service_tier" | "text" | "reasoning">;
export type SerializeResponsesMessagesOptions = {
    instructions?: string | undefined;
    includeInstructionsInInput?: boolean | undefined;
    blockImages?: boolean | undefined;
    grammarToolInputProperties?: ReadonlyMap<string, string> | undefined;
    /**
     * Whether `messages` starts at the transcript head. Compaction live tails and replay windows
     * continue a longer transcript, so their first system message is a mid-conversation update.
     */
    startsAtTranscriptHead?: boolean | undefined;
    /**
     * Tool placement decided once for the whole transcript. Replay callers that serialize several
     * slices of one transcript pass it, so no slice re-decides how tools are declared.
     */
    toolPlacement?: DeferredToolPlacement | undefined;
};
export type ResponsesParityReport = {
    ok: boolean;
    actual: string[];
    expected: string[];
    mismatches: string[];
};
export type SerializedResponsesHistory = {
    input: ResponsesInputItem[];
    /**
     * The placement that produced `input`. Its `immediate` tools are the request's top-level set,
     * so an assembler that replays this history declares exactly the same tools as the transcript.
     */
    toolPlacement: DeferredToolPlacement;
};
/**
 * Reconstruct the provider history for a session branch. Returns the placement decision together
 * with the items: a caller that assembles a request from this history (native compaction) must
 * declare the same top-level tools instead of deriving them from another context.
 */
export declare function serializeActiveSessionHistory<TApi extends Api>(args: {
    model: Model<TApi>;
    entries: SessionEntry[];
    leafId?: string | null | undefined;
    options?: SerializeResponsesMessagesOptions | undefined;
}): SerializedResponsesHistory;
export declare function serializeMessagesToResponsesInput<TApi extends Api>(model: Model<TApi>, messages: AgentMessage[], options?: SerializeResponsesMessagesOptions): ResponsesInputItem[];
export declare function createResponsesInputParitySignature(input: readonly unknown[]): string[];
export declare function compareResponsesInputParity(actual: readonly unknown[], expected: readonly unknown[]): ResponsesParityReport;
export {};
