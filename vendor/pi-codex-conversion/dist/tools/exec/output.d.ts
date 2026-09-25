import type { ExecOutputBuffer } from "./output-buffer.ts";
export interface ExecOutputSessionState {
    buffer: ExecOutputBuffer;
    emittedOffset: number;
}
export declare function normalizePipeOutput(text: string): string;
export declare function renderTerminalOutput(text: string): string;
export declare function truncateToTail(text: string, maxChars: number): {
    output: string;
    removed: number;
};
export declare function generateChunkId(): string;
export declare function truncateOutput(text: string, maxOutputTokens?: number, originalCharCount?: number): {
    output: string;
    original_token_count?: number | undefined;
};
export declare function consumeOutput(session: ExecOutputSessionState, maxOutputTokens?: number): {
    output: string;
    original_token_count?: number | undefined;
};
export declare function peekUnconsumedOutput(session: ExecOutputSessionState, maxOutputTokens?: number): {
    output: string;
    original_token_count?: number | undefined;
};
export declare function peekOutputSince(session: ExecOutputSessionState, baselineOffset: number, maxOutputTokens?: number): {
    output: string;
    original_token_count?: number | undefined;
};
