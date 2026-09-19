import type { OpenAICodexStreamOptions } from "./types.ts";
export { acquireWebSocket, closeOpenAICodexWebSocketSessions, isWebSocketSseFallbackActive, recordWebSocketSseFallback, resetOpenAICodexWebSocketSessions, } from "./websocket-session-cache.ts";
export { parseWebSocket, startWebSocketOutputOnFirstEvent } from "./websocket-parser.ts";
export declare function validateWebSocketTimeoutOptions(options: OpenAICodexStreamOptions | undefined): void;
