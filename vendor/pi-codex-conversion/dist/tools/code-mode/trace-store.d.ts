import type { RuntimeResponse, RuntimeToolResult, RuntimeToolTrace, ToolExecutionContext } from "./types.js";
export declare class CodeModeTraceStore {
    private readonly traces;
    private readonly droppedCounts;
    clear(): void;
    delete(cellId: string): void;
    start(cellId: string, id: string, name: string, input: unknown): RuntimeToolTrace;
    captureResult(cellId: string, current: RuntimeToolTrace, result: RuntimeToolResult): RuntimeToolResult;
    emitUpdate(cellId: string, context: ToolExecutionContext): void;
    attach(response: RuntimeResponse): RuntimeResponse;
}
