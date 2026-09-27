export declare function occKey(toolCallId: string, resultTimestamp?: number): string;
/**
 * Narrows an untrusted value to the numeric timestamp discriminant, or
 * `undefined` if it isn't a number. Shared by every ingress point that reads
 * a ToolResultMessage-shaped `.timestamp` off data of uncertain provenance
 * (live turn events, session JSON, summary details JSON).
 */
export declare function resultTimestampOf(value: unknown): number | undefined;
export declare function parseOccKey(key: string): {
    toolCallId: string;
    resultTimestamp?: number;
};
export declare function bareToolCallId(key: string): string;
