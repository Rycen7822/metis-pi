import type { RuntimeToolResult, ToolExecutionContext } from "./types.js";
export interface FusionEvidenceRef {
    path: string;
    offsetBytes: number;
    bytes: number;
}
/** Durable receipts have a separate lifetime from the bounded display traces. */
export declare class FusionEvidenceStore {
    private readonly journals;
    capture(cellId: string, id: string, toolName: string, input: unknown, result: RuntimeToolResult, context: ToolExecutionContext): void;
    take(cellId: string): {
        fusionEvidence?: FusionEvidenceRef;
        fusionEvidenceError?: string;
    };
    delete(cellId: string): void;
    clear(): void;
}
