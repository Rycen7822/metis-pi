import { connectWebSocket } from "../../providers/openai-codex/websocket-connection.ts";
import type { CodexVoiceAuth } from "../auth.ts";
export interface CodexDictationTranscriberCallbacks {
    onError(error: Error): void;
    onStatus(status: string): void;
}
export declare class CodexDictationTranscriber {
    private readonly callbacks;
    private readonly connector;
    private state;
    private socket;
    private audioBytes;
    private completion;
    private setupAbortController;
    constructor(callbacks: CodexDictationTranscriberCallbacks, connector?: typeof connectWebSocket);
    start(auth: CodexVoiceAuth): Promise<void>;
    append(pcm: Buffer): void;
    finish(): Promise<string | undefined>;
    close(): Promise<void>;
    private receive;
    private fail;
}
