import type { ProviderEnv, WebSocketLike } from "./types.ts";
export declare function resolveWebSocketProxyForTarget(url: string, env?: ProviderEnv): Promise<string | undefined>;
export declare function isWebSocketReusable(socket: WebSocketLike): boolean;
export declare function closeWebSocketSilently(socket: WebSocketLike, code?: number, reason?: string): void;
export declare function isWebSocketUpgradeRequiredError(error: unknown): boolean;
export declare function isWebSocketMessageTooBigError(error: unknown): boolean;
export declare function isPermanentWebSocketError(error: unknown): boolean;
export declare function isWebSocketUnauthorizedError(error: unknown): boolean;
export declare function extractWebSocketError(event: unknown): Error;
export declare class WebSocketCloseError extends Error {
    readonly code?: number | undefined;
    readonly reason?: string | undefined;
    constructor(message: string, options?: {
        code?: number | undefined;
        reason?: string | undefined;
    });
}
export declare function extractWebSocketCloseError(event: unknown): Error;
export declare function connectWebSocket(url: string, headers: Headers, signal: AbortSignal | undefined, connectTimeoutMs?: number, env?: ProviderEnv): Promise<WebSocketLike>;
