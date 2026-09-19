import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ProgrammaticCodeModeToolDefinition, CodeModeToolIdentity } from "../../tools/code-mode/types.ts";
interface NestedToolLifecycle {
    start?(id: string, input: unknown): void;
    end?(id: string): void;
}
interface NestedToolContract {
    kind?: "function" | "freeform";
    textOutput?: "plain-command";
    blocking?: boolean;
    isBlocking?(input: unknown): boolean;
    deferLoading?: boolean;
    discoverWhenDeferred?: boolean;
    modelVisibleResult?: boolean;
    translatePromptMetadata?: boolean;
    toolName?: CodeModeToolIdentity;
    yieldTimeMs?: number;
    prepareInput?(input: unknown): unknown;
    resultError?(result: AgentToolResult<unknown>): string | undefined;
    resultValue?(result: AgentToolResult<unknown>): unknown;
}
export declare function toNestedTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>, usage: string, lifecycle?: NestedToolLifecycle, contract?: NestedToolContract): ProgrammaticCodeModeToolDefinition;
export declare function codeModeImageResult(result: AgentToolResult<unknown>, outputHint?: string): unknown;
export {};
