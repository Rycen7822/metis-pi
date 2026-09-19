import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { CodexVoiceAuth } from "../auth.ts";
export interface CodexDictationCallbacks {
    onError(error: Error): void;
    onStatus(status: string): void;
    onTranscript(transcript: string): void;
}
export declare class CodexDictationSession {
    private readonly callbacks;
    private readonly helper;
    private readonly transcriber;
    private state;
    private startupFailure;
    constructor(callbacks: CodexDictationCallbacks);
    start(auth: CodexVoiceAuth, config: CodexConversionConfig): Promise<void>;
    finish(): Promise<void>;
    close(): Promise<void>;
    private handleHelperEvent;
    private fail;
}
