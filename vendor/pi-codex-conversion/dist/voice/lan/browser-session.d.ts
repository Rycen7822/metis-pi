import { WebSocket } from "ws";
import { LanVoiceBrowserConnections } from "./browser-connections.ts";
import type { LanVoiceDraftSelection } from "./draft.ts";
export type LanVoiceBrowserMode = "conversation" | "dictation";
export interface LanVoiceBrowserClientsOptions {
    ensureConversation(): Promise<void>;
    startDictation(clientId: string): Promise<void>;
    finishDictation(clientId: string, draft?: string, revision?: number, selection?: LanVoiceDraftSelection): Promise<void>;
    cancelDictation(clientId: string): Promise<void>;
    onConversationActivity(active: boolean): void | Promise<void>;
    onConversationMute(muted: boolean): void;
    conversationMuted(): boolean;
    onConversationInputTooQuiet(inputTooQuiet: boolean): void;
    onConversationAudio(pcm: Buffer): void;
    onDictationAudio(clientId: string, pcm: Buffer): void;
}
export declare class LanVoiceBrowserSession {
    private readonly options;
    private readonly connections;
    private state;
    private operation;
    private conversationOwnerId;
    private readonly microphoneLevel;
    constructor(options: LanVoiceBrowserClientsOptions, connections: LanVoiceBrowserConnections);
    get closed(): boolean;
    sendConversationAudio(pcm: Buffer): void;
    release(clientId: string, socket?: WebSocket, terminateConversation?: boolean): void;
    releaseStarting(clientId: string, socket?: WebSocket): void;
    claim(clientId: string, socket: WebSocket, mode: LanVoiceBrowserMode): Promise<void>;
    finish(clientId: string, socket: WebSocket, draft: string, revision: number, selection: LanVoiceDraftSelection): Promise<void>;
    cancelDictation(clientId: string): Promise<void>;
    resetConversationInputLevel(): void;
    mute(clientId: string, socket: WebSocket, muted: boolean): void;
    receiveAudio(clientId: string, socket: WebSocket, pcm: Buffer): void;
    close(): Promise<void>;
    private enqueue;
}
