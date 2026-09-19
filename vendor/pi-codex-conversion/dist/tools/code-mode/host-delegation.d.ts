import { type HostMessage } from "./host-protocol.js";
import type { CodeModeToolDefinition, RuntimeResponse, ToolExecutionContext } from "./types.js";
import type { CodeModeNestedRenderStore } from "./trace-render-state.js";
export declare class CodeModeHostDelegation {
    private readonly runtime;
    constructor(send: (message: unknown) => void, renderStore?: CodeModeNestedRenderStore);
    bindResponse(value: unknown, context?: ToolExecutionContext, tools?: Map<string, CodeModeToolDefinition>): void;
    updateCellContext(cellId: string, context: ToolExecutionContext): void;
    isBlocked(cellId: string): boolean;
    waitUntilUnblocked(cellId: string, signal?: AbortSignal): Promise<void>;
    attach(response: RuntimeResponse): RuntimeResponse;
    clear(): void;
    handleMessage(message: HostMessage): void;
}
