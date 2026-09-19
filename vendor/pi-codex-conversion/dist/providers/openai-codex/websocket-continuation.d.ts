import type { CachedWebSocketContinuationState, CachedWebSocketRequestBodyResult, ResponsesBody } from "./types.ts";
export declare function requestBodyForWebSocketContinuationComparison(body: ResponsesBody): ResponsesBody;
export declare function responseInputsEqual(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean;
export declare function buildCachedWebSocketRequestBody(continuation: CachedWebSocketContinuationState | undefined, body: ResponsesBody): CachedWebSocketRequestBodyResult;
