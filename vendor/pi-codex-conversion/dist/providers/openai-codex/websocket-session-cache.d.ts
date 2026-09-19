import type { AcquiredWebSocket, ProviderEnv } from "./types.ts";
export declare function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean;
export declare function recordWebSocketSseFallback(sessionId: string | undefined): void;
export declare function resetOpenAICodexWebSocketSessions(sessionId?: string): void;
export declare function closeOpenAICodexWebSocketSessions(sessionId?: string): void;
export declare function acquireWebSocket(url: string, headers: Headers, sessionId: string | undefined, accountId: string, signal: AbortSignal | undefined, connectTimeoutMs?: number, env?: ProviderEnv): Promise<AcquiredWebSocket>;
