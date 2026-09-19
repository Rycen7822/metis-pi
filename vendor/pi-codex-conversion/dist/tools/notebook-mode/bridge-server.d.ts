import type { CodeModeToolIdentity, NotebookMemoryUsage, RuntimeContentItem } from "../code-mode/types.ts";
export interface NotebookBridgeHandlers {
    callTool(cellId: string, requestId: number, toolName: CodeModeToolIdentity, input: unknown): Promise<unknown>;
    cancelTools(cellId: string): void;
    emit(cellId: string, items: RuntimeContentItem[]): void;
    notify(cellId: string, text: string): void;
    yield(cellId: string): void;
    memory(cellId: string, usage: NotebookMemoryUsage): void;
}
export declare class NotebookBridgeServer {
    readonly token: string;
    readonly exitToken: string;
    private readonly handlers;
    private server;
    private origin;
    constructor(handlers: NotebookBridgeHandlers);
    start(): Promise<string>;
    shutdown(): Promise<void>;
    private handle;
}
