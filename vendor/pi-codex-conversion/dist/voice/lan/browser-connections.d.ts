import type { ServerResponse } from "node:http";
import { WebSocket, type RawData } from "ws";
interface AudioConnectionCallbacks {
    onMessage(data: RawData, isBinary: boolean): void;
    onReplaced(previous: WebSocket): void;
    onClose(): void;
}
export declare class LanVoiceBrowserConnections {
    private readonly eventResponses;
    private readonly audioSockets;
    connectEvents(clientId: string, response: ServerResponse, closed: boolean): void;
    connectAudio(clientId: string, socket: WebSocket, closed: boolean, callbacks: AudioConnectionCallbacks): void;
    isCurrentAudio(clientId: string, socket: WebSocket): boolean;
    sendControl(clientId: string, value: unknown): void;
    broadcastControl(value: unknown): void;
    sendAudio(socket: WebSocket, pcm: Buffer): void;
    heartbeat(): void;
    close(failures: unknown[]): void;
}
export {};
