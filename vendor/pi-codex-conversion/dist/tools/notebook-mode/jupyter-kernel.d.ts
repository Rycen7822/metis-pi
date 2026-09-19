import type { RuntimeContentItem } from "../code-mode/types.ts";
import { type KernelExecutionResult } from "./jupyter-output.ts";
export type { KernelExecutionResult } from "./jupyter-output.ts";
export declare class DenoJupyterKernel {
    private readonly deno;
    private readonly env;
    private readonly maxHeapMiB;
    private readonly onFailure;
    private readonly session;
    private process;
    private tempDir;
    private connection;
    private shell;
    private control;
    private iopub;
    private shellPump;
    private iopubPump;
    private startup;
    private active;
    private readonly shellReplies;
    private stderr;
    private terminalFailure;
    constructor(options: {
        deno: string;
        maxHeapMiB: number;
        env?: NodeJS.ProcessEnv | undefined;
        onFailure?: ((kernel: DenoJupyterKernel, error: Error) => void) | undefined;
    });
    start(signal?: AbortSignal): Promise<void>;
    execute(code: string, options?: {
        cellSource?: string | undefined;
        signal?: AbortSignal | undefined;
        onOutput?: ((item: RuntimeContentItem) => void) | undefined;
        interruptOnAbort?: boolean | undefined;
    }): Promise<KernelExecutionResult>;
    complete(code?: string, cursorPosition?: number, signal?: AbortSignal): Promise<string[]>;
    interrupt(): Promise<void>;
    shutdown(): Promise<void>;
    private startInner;
    private waitForKernelReady;
    private shellRequest;
    private sendShellRequest;
    private runShellPump;
    private runIopubPump;
    private handleIopub;
    private failKernel;
    private dispose;
}
