import type { NotebookMemoryUsage, RuntimeResponse } from "./types.js";
export declare function toCodeModeToolResult(response: RuntimeResponse, maxTokens?: number): {
    content: NonNullable<{
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    } | undefined>[];
    details: {
        scriptError?: string;
        notebookMemory?: NotebookMemoryUsage;
        droppedTraceCount?: number;
        traces?: import("./types.js").RuntimeToolTrace[];
        codeMode: boolean;
        cellId: string;
        status: "result" | "yielded" | "terminated";
    };
};
export declare function formatNotebookMemoryWarning(memory: NotebookMemoryUsage): string | undefined;
export declare function formatRunningExecSessionGuidance(sessionId: number): string;
