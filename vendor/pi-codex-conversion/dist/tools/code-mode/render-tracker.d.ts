type RenderStatus = "running" | "done" | "yielded";
export interface CodeModeRenderTracker {
    register(toolCallId: string | undefined, invalidate: (() => void) | undefined): void;
    start(toolCallId: string): void;
    finish(toolCallId: string, status?: Exclude<RenderStatus, "running">): void;
    status(toolCallId: string | undefined): RenderStatus;
}
export declare function createCodeModeRenderTracker(): CodeModeRenderTracker;
export {};
