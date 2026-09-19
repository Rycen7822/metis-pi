export interface BridgeReadResponse {
    chunks: Array<{
        seq: number;
        stream: "stdout" | "stderr" | "pty";
        chunk: string;
    }>;
    nextSeq: number;
    exited: boolean;
    exitCode?: number | null | undefined;
    closed: boolean;
    failure?: string | null | undefined;
}
export interface ExecBridgeClient {
    request<T = unknown>(request: Record<string, unknown>): Promise<T>;
    shutdown(): Promise<void>;
}
export declare function formatExecBridgeExitError(stderr: string, code?: number | null | undefined, signal?: NodeJS.Signals | null | undefined): string;
export declare function createExecBridgeClient(binaryPath?: () => string | undefined): ExecBridgeClient;
export declare function chunkToBytes(chunk: string): Buffer;
