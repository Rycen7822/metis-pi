import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodeModeToolIdentity, NotebookMemoryUsage, RuntimeContentItem } from "../code-mode/types.ts";
export type NotebookBridgeRequest = {
    kind: "tool";
    cellId: string;
    requestId: number;
    toolName: CodeModeToolIdentity;
    input: unknown;
} | {
    kind: "cancel_tools";
    cellId: string;
} | {
    kind: "emit";
    cellId: string;
    items: RuntimeContentItem[];
} | {
    kind: "notify";
    cellId: string;
    text: string;
} | {
    kind: "yield";
    cellId: string;
} | {
    kind: "memory";
    cellId: string;
    usage: NotebookMemoryUsage;
};
export declare function readNotebookBridgeRequest(request: IncomingMessage): Promise<NotebookBridgeRequest>;
export declare function writeNotebookBridgeJson(response: ServerResponse, status: number, value: unknown): void;
