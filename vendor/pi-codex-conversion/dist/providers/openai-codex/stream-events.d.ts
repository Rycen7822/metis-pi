import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { OpenAICodexStreamOptions, StreamEventShape } from "./types.ts";
export declare class CodexProtocolError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function isRetryableCodexStreamError(error: unknown): boolean;
export declare function isCodexApiError(error: unknown): boolean;
export declare function codexStreamRetryDelay(error: unknown): number | undefined;
export declare function createCodexHttpError(message: string, code: string | undefined, status: number): Error;
export declare function isCodexOverloadError(error: unknown): boolean;
export declare function isCodexRateLimitError(error: unknown): boolean;
export declare function codexOverloadRetryDelay(error: unknown, retryCount: number, waitedMs: number): number | undefined;
export declare function codexRateLimitRetryDelay(error: unknown, fallbackDelayMs: number, waitedMs: number): number | undefined;
export declare function assertSuccessfulCodexOutput(output: AssistantMessage): asserts output is AssistantMessage & {
    stopReason: "stop" | "length" | "toolUse";
};
export declare function assertSuccessfulCodexStatus(status: string | undefined): asserts status is "completed";
export declare function mapCodexEvents(events: AsyncIterable<StreamEventShape>, output?: AssistantMessage): AsyncIterable<StreamEventShape>;
export declare function processMappedCodexResponsesStream<TApi extends Api>(events: AsyncIterable<StreamEventShape>, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<TApi>, options: OpenAICodexStreamOptions | undefined): Promise<void>;
export declare function processCodexResponsesStream<TApi extends Api>(events: AsyncIterable<StreamEventShape>, output: AssistantMessage, stream: AssistantMessageEventStream, model: Model<TApi>, options: OpenAICodexStreamOptions | undefined): Promise<void>;
