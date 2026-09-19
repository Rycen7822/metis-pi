import type { KernelExecutionResult } from "./jupyter-kernel.ts";
import type { RuntimeContentItem, ToolExecutionContext } from "../code-mode/types.ts";
export declare class NotebookCell {
    readonly id: string;
    readonly source: string;
    readonly controller: AbortController;
    readonly items: RuntimeContentItem[];
    readonly maxOutputTokens: number;
    context: ToolExecutionContext;
    result?: KernelExecutionResult | undefined;
    terminated: boolean;
    private outputChars;
    private outputTruncated;
    private cursor;
    private completedValue;
    private yielded;
    private blockersChanged;
    private readonly blockers;
    private readonly completed;
    constructor(options: {
        id: string;
        source: string;
        context: ToolExecutionContext;
        maxOutputTokens: number;
    });
    observe(yieldTimeMs: number, signal?: AbortSignal): Promise<"result" | "yielded">;
    markCompleted(): void;
    isCompleted(): boolean;
    waitForCompletion(): Promise<void>;
    requestYield(): void;
    setBlocked(blockerId: string, active: boolean): void;
    takeContent(): RuntimeContentItem[];
    emit(items: RuntimeContentItem[]): void;
}
