import type { RuntimeToolResult, RuntimeToolTrace } from "./types.js";
export declare function toolResultFromValue(value: unknown): RuntimeToolResult;
export declare function cloneTrace(trace: RuntimeToolTrace): RuntimeToolTrace;
export declare function boundRuntimeToolResult(result: RuntimeToolResult, imageCharsRemaining: number): RuntimeToolResult;
export declare function truncateTraceText(text: string, remaining: number): string;
export declare function sanitizeTraceInput(value: unknown, maxChars: number): unknown;
