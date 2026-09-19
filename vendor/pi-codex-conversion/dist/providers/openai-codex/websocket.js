import { normalizeTimeoutMs } from "./sse.js";
export { acquireWebSocket, closeOpenAICodexWebSocketSessions, isWebSocketSseFallbackActive, recordWebSocketSseFallback, resetOpenAICodexWebSocketSessions, } from "./websocket-session-cache.js";
export { parseWebSocket, startWebSocketOutputOnFirstEvent } from "./websocket-parser.js";
export function validateWebSocketTimeoutOptions(options) {
    normalizeTimeoutMs(options?.timeoutMs, "timeoutMs");
    normalizeTimeoutMs(options?.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
}
