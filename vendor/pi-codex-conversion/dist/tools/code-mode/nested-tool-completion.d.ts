import type { ToolExecutionContext } from "./types.js";
export declare function runCodeModeToolWithHooks(toolName: string, input: unknown, context: ToolExecutionContext, signal: AbortSignal, run: (context: ToolExecutionContext) => Promise<unknown>): Promise<unknown>;
