import { type VoiceHelperCommand, type VoiceHelperEvent } from "./helper-protocol.ts";
export type { VoiceHelperCommand, VoiceHelperEvent } from "./helper-protocol.ts";
export { BoundedJsonlReader, parseVoiceHelperEvent } from "./helper-protocol.ts";
export declare class VoiceHelperClient {
    private child;
    private listeners;
    private exitListeners;
    private stdinFailures;
    private helperProtocolVersion;
    get protocolVersion(): number | undefined;
    onEvent(listener: (event: VoiceHelperEvent) => void): () => void;
    onExit(listener: (error: Error) => void): () => void;
    start(customRustBinariesDir?: string | undefined): Promise<void>;
    send(command: VoiceHelperCommand): void;
    stop(): Promise<void>;
    close(): Promise<void>;
    private fail;
    private handleStdinError;
}
