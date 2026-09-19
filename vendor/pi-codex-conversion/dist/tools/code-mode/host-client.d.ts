import type { CodeModeNestedRenderStore } from "./trace-render-state.js";
import type { CodeModeToolDefinition, RuntimeResponse, ToolExecutionContext } from "./types.js";
export { scopeAllToolsToDeferredCustom } from "./tool-source.js";
type HostClientOptions = {
    binary: string;
    tools: CodeModeToolDefinition[];
    renderStore?: CodeModeNestedRenderStore | undefined;
    shutdownGraceMs?: number | undefined;
};
export declare class CodeModeHostClient {
    private readonly tools;
    private readonly session;
    private readonly delegation;
    private readonly cells;
    constructor(options: HostClientOptions);
    start(): Promise<void>;
    execute(source: string, context: ToolExecutionContext, signal?: AbortSignal, tools?: CodeModeToolDefinition[]): Promise<RuntimeResponse>;
    private waitForBlockers;
    wait(cellId: string, yieldTimeMs: number, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    terminate(cellId: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    shutdown(): Promise<void>;
}
