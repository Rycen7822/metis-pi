import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { type LanVoiceBrowserClientsOptions } from "./browser-session.ts";
export { MAX_CONTROL_BYTES } from "./browser-wire.ts";
export declare class LanVoiceBrowserClients {
    private readonly connections;
    private readonly session;
    constructor(options: LanVoiceBrowserClientsOptions);
    connectEvents(clientId: string, response: ServerResponse): void;
    connectAudio(clientId: string, socket: WebSocket): void;
    sendControl(clientId: string, value: unknown): void;
    broadcastControl(value: unknown): void;
    sendConversationAudio(pcm: Buffer): void;
    resetConversationInputLevel(): void;
    release(clientId: string, socket?: WebSocket, terminateConversation?: boolean): void;
    heartbeat(): void;
    close(): Promise<void>;
    private receive;
    private sendSocketError;
}
