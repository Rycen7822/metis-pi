import { StringDecoder } from "node:string_decoder";
export interface BridgeExecInput {
    command: string;
    executionCommand: string;
    executionEnv: NodeJS.ProcessEnv;
    tty?: boolean | undefined;
    login?: boolean | undefined;
}
export interface BridgeExecSession {
    id: number;
    processId: string;
    startup: Promise<void>;
    started: boolean;
    tty: boolean;
    command: string;
    buffer: string;
    bufferStartOffset: number;
    emittedOffset: number;
    outputVersion: number;
    exitCode: number | null | undefined;
    listeners: Set<() => void>;
    interactive: boolean;
    nextEmptyPollYieldMs?: number | undefined;
    lastSeq: number;
    startedAt: number;
    updatedAt: number;
    finalized: boolean;
    exposed: boolean;
    terminating: boolean;
    outputDecoders: Record<"stdout" | "stderr" | "pty", StringDecoder>;
    outputDecodersFlushed: boolean;
    postExitIdleSince?: number | undefined;
    observedExitCode?: number | null | undefined;
}
export interface BridgeSessionHooks {
    isOwned(session: BridgeExecSession): boolean;
    onOutput(session: BridgeExecSession, text: string): void;
    onExit(session: BridgeExecSession): void;
}
export interface BridgeSessionRuntime {
    create(args: {
        id: number;
        input: BridgeExecInput;
        workdir: string;
        shell: string;
        signal?: AbortSignal | undefined;
        hooks: BridgeSessionHooks;
    }): BridgeExecSession;
    poll(session: BridgeExecSession, hooks: BridgeSessionHooks, waitMs?: number, maxBytes?: number): Promise<void>;
    waitForStartup(session: BridgeExecSession, signal?: AbortSignal): Promise<void>;
    write(session: BridgeExecSession, chars: string): Promise<void>;
    terminate(session: BridgeExecSession): Promise<void>;
    shutdown(): Promise<void>;
}
export declare function createBridgeSessionRuntime(binaryPath?: () => string | undefined): BridgeSessionRuntime;
