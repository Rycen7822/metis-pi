import type { CodeModeToolDefinition, CustomToolDefinition, RuntimeResponse } from "./types.js";
export declare const MAX_CODE_MODE_OUTPUT_TOKENS = 100000;
export declare const DEFAULT_CODE_MODE_OUTPUT_TOKENS = 10000;
export declare const DEFAULT_CODE_MODE_EXEC_YIELD_MS = 30000;
export declare function toWireToolDefinition(tool: CodeModeToolDefinition): {
    name: string;
    tool_name: {
        name: string;
        namespace: string | null;
    };
    description: string;
    kind: "function" | "freeform";
    input_schema: {} | null;
    output_schema: null;
};
export declare function isCustomToolDefinition(tool: CodeModeToolDefinition): tool is CustomToolDefinition;
export declare function parseExecSource(source: string): {
    code: string;
    yieldTimeMs: number | null;
    maxOutputTokens: number | null;
};
export declare function parseRuntimeResponse(value: unknown): RuntimeResponse;
export type HostMessage = {
    type: "connection/ready";
    selectedVersion: 1;
    capabilities: string[];
} | {
    type: "connection/rejected";
    reason: unknown;
} | {
    type: "operation/response";
    id: number;
    result: HostResult;
} | {
    type: "execute/initialResponse";
    id: number;
    result: HostResult;
} | ({
    type: "delegate/request";
} & DelegateRequestMessage) | {
    type: "delegate/cancel";
    id: number;
} | {
    type: "cell/closed";
    cellId: string;
};
export interface DelegateRequestMessage {
    id: number;
    request: {
        type: "notification/send";
        cellId: string;
        text: string;
    } | {
        type: "tool/invoke";
        invocation: {
            cell_id: string;
            input?: unknown;
            runtime_tool_call_id: string;
            tool_name: {
                name: string;
                namespace?: string | undefined;
            };
        };
    };
}
export type HostResult = {
    status: "ok";
    value: unknown;
} | {
    status: "error";
    message: string;
};
export declare function parseHostMessage(value: unknown): HostMessage;
export declare function executionCellId(value: unknown): string | undefined;
export declare function runtimeOutcome(value: unknown): unknown;
export declare function isMissingRuntimeOutcome(value: unknown): boolean;
