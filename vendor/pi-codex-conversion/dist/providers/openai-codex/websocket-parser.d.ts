import type { StreamEventShape, WebSocketLike } from "./types.ts";
export declare function parseWebSocket(socket: WebSocketLike, signal: AbortSignal | undefined, idleTimeoutMs?: number, onTurnState?: (value: string) => void): AsyncIterable<StreamEventShape>;
export declare function startWebSocketOutputOnFirstEvent(events: AsyncIterable<StreamEventShape>, onStart: () => void): AsyncIterable<StreamEventShape>;
