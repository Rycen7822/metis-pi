import type { CodeModeExecutionClient, NotebookRuntimeOptions } from "../code-mode/shared-runtime.ts";
import type { CodeModeNestedRenderStore } from "../code-mode/trace-render-state.ts";
import type { CodeModeToolDefinition, NotebookControlRequest, NotebookControlResult, RuntimeResponse, ToolExecutionContext } from "../code-mode/types.ts";
export declare class NotebookCodeModeClient implements CodeModeExecutionClient {
    private readonly execution;
    private readonly session;
    private readonly lifecycle;
    private readonly recovery;
    constructor(options: NotebookRuntimeOptions, renderStore?: CodeModeNestedRenderStore);
    execute(source: string, context: ToolExecutionContext, signal?: AbortSignal, tools?: CodeModeToolDefinition[]): Promise<RuntimeResponse>;
    wait(cellId: string, yieldTimeMs: number, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    terminate(cellId: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    checkpoint(excludeNames?: ReadonlySet<string>, pins?: {
        names: readonly string[];
        pinned: boolean;
    }): Promise<void>;
    controlNotebook(request: NotebookControlRequest, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    shutdown(): Promise<void>;
    private prepareSession;
    private stopWithoutCheckpoint;
}
