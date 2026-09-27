import type { CapturedBatch, CapturedToolCall } from "./types.js";
export declare function packToolResult(call: CapturedToolCall): string | undefined;
/** Preparation is pure: no index/frontier changes before the model decision. */
export declare function prepareBatch(batch: CapturedBatch): {
    candidate: CapturedBatch;
    candidateChars: number;
    packedBatch: {
        toolCalls: CapturedToolCall[];
        turnIndex: number;
        timestamp: number;
        assistantText: string;
        userTurnGroup?: number;
    };
    packedText: string;
};
