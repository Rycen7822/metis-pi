import type { CodexVoiceAuth } from "../auth.ts";
export declare class LanVoiceDictation {
    private readonly resolveAuth;
    private readonly onError;
    private current;
    private finishing;
    constructor(options: {
        resolveAuth(): Promise<CodexVoiceAuth>;
        onError(clientId: string, error: Error): void;
    });
    start(clientId: string): Promise<void>;
    append(clientId: string, pcm: Buffer): void;
    finish(clientId: string): Promise<string | undefined>;
    cancel(clientId: string): Promise<void>;
    close(): Promise<void>;
}
