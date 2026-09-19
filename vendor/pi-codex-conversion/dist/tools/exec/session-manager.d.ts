export interface UnifiedExecResult {
    chunk_id: string;
    wall_time_seconds: number;
    output: string;
    exit_code?: number | undefined;
    session_id?: number | undefined;
    original_token_count?: number | undefined;
}
export interface ExecSessionSnapshot {
    id: number;
    command: string;
    running: boolean;
    exitCode?: number | undefined;
    startedAt: number;
    updatedAt: number;
    outputTail: string;
    terminating: boolean;
}
export type ExecSessionChangeReason = "start" | "output" | "exit" | "terminate";
export interface ExecCommandInput {
    cmd: string;
    workdir?: string | undefined;
    shell?: string | undefined;
    defaultShell?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    tty?: boolean | undefined;
    yield_time_ms?: number | undefined;
    max_yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
    login?: boolean | undefined;
    wait_until_exit?: boolean | undefined;
}
export interface WriteStdinInput {
    session_id: number;
    chars?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
}
export type ExecSessionUpdateCallback = (result: UnifiedExecResult) => void;
export interface ExecSessionManager {
    setBaseEnv(env: NodeJS.ProcessEnv): void;
    exec(input: ExecCommandInput, cwd: string, signal?: AbortSignal, onUpdate?: ExecSessionUpdateCallback): Promise<UnifiedExecResult>;
    write(input: WriteStdinInput, signal?: AbortSignal, onUpdate?: ExecSessionUpdateCallback): Promise<UnifiedExecResult>;
    hasSession(sessionId: number): boolean;
    getSessionCommand(sessionId: number): string | undefined;
    listSessions(maxOutputChars?: number): ExecSessionSnapshot[];
    terminateSession(sessionId: number): boolean;
    onSessionChange(listener: (reason: ExecSessionChangeReason) => void): () => void;
    onSessionExit(listener: (sessionId: number, command: string) => void): () => void;
    shutdown(): Promise<void>;
}
export interface ExecSessionManagerOptions {
    env?: NodeJS.ProcessEnv | undefined;
    bridgeBinaryPath?: (() => string | undefined) | undefined;
    defaultExecYieldTimeMs?: number | undefined;
    defaultWriteYieldTimeMs?: number | undefined;
    minNonInteractiveExecYieldTimeMs?: number | undefined;
    minEmptyWriteYieldTimeMs?: number | undefined;
    maxEmptyWriteYieldTimeMs?: number | undefined;
    maxSessionBufferChars?: number | undefined;
}
export declare function createExecSessionManager(options?: ExecSessionManagerOptions): ExecSessionManager;
