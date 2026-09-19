import type { KernelExecutionResult } from "./jupyter-kernel.ts";
export interface NotebookBindingStatus {
    name: string;
    type: string;
    constructor?: string | undefined;
    kind: "value" | "definition" | "runtime-only";
    disposable?: "sync" | "async" | undefined;
    globalProperty: boolean;
}
export interface NotebookKernelStatus {
    memory: {
        heapUsedBytes: number;
        heapTotalBytes: number;
        heapLimitBytes: number;
        rssBytes: number;
        externalBytes: number;
    };
    bindings: NotebookBindingStatus[];
}
export interface NotebookReleaseResult {
    released: string[];
    disposed: string[];
    failures: Array<{
        name: string;
        reason: string;
    }>;
}
export declare function notebookStatusSource(names: string[], marker: string): string;
export declare function notebookReleaseSource(names: string[], marker: string): string;
export declare function notebookDisposeSource(names: string[], marker: string): string;
export declare function parseNotebookRuntimeResult<T>(result: KernelExecutionResult, marker: string): T;
