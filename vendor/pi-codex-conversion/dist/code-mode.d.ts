import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
export { type CodeModeExtensionToolProvider, type CodeModeExtensionToolRegistration, type CodeModeExtensionToolRegistrationOptions, registerCodeModeExtensionTools, } from "./code-mode-extension-tools.ts";
import type { CodeModeToolIdentity, ProgrammaticCodeModeToolDefinition } from "./tools/code-mode/types.ts";
export declare function adaptToolForCodeMode<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>, options: {
    usage: string;
    blocking?: boolean | ((input: unknown) => boolean);
    deferLoading?: boolean;
    kind?: "function" | "freeform";
    promptMetadata?: boolean;
    prepareInput?(input: unknown): unknown;
    toolName?: CodeModeToolIdentity;
    resultValue?(result: AgentToolResult<NoInfer<TDetails>>): unknown;
}): ProgrammaticCodeModeToolDefinition;
