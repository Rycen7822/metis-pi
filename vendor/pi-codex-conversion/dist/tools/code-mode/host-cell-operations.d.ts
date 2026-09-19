import type { CodeModeHostDelegation } from "./host-delegation.js";
import type { CodeModeHostSession } from "./host-session.js";
import type { RuntimeResponse, ToolExecutionContext } from "./types.js";
export declare class CodeModeHostCellOperations {
    private readonly session;
    private readonly delegation;
    constructor(session: CodeModeHostSession, delegation: CodeModeHostDelegation);
    wait(cellId: string, yieldTimeMs: number, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    terminate(cellId: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    private run;
}
