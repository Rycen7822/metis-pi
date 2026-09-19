export declare const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export interface ResponsesLiteCompatibleBody {
    model: string;
    input: unknown[];
    instructions?: string | undefined;
    tools?: unknown[] | undefined;
    parallel_tool_calls?: boolean | undefined;
    reasoning?: unknown | undefined;
    client_metadata?: Record<string, string> | undefined;
    [key: string]: unknown;
}
export declare function isResponsesLiteRequest(body: ResponsesLiteCompatibleBody): boolean;
export declare function prepareResponsesLiteConversationInput(input: readonly unknown[]): Promise<unknown[]>;
export declare function prepareResponsesLiteRequestImages<TBody extends ResponsesLiteCompatibleBody>(body: TBody): Promise<TBody>;
export declare function applyResponsesLiteRequest<TBody extends ResponsesLiteCompatibleBody>(body: TBody): TBody;
export declare function namespaceExistingResponsesLiteRequest<TBody extends ResponsesLiteCompatibleBody>(body: TBody): TBody;
export declare function applyResponsesLiteWebSocketMetadata<TBody extends ResponsesLiteCompatibleBody>(body: TBody): TBody & {
    client_metadata: Record<string, string>;
};
