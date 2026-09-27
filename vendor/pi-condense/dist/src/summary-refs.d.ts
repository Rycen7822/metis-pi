import type { CapturedBatch } from "./types.js";
export interface SummaryToolCallRef {
    shortId: string;
    toolCallId: string;
    /** ToolResultMessage timestamp; combines with toolCallId into the occurrence key. */
    resultTimestamp?: number;
}
export interface SummaryMessageDetailsLike {
    toolCallRefs?: SummaryToolCallRef[];
    toolCallIds?: string[];
}
export declare function buildShortToolCallRefs(calls: {
    toolCallId: string;
    resultTimestamp?: number;
}[], startIndex: number): {
    refs: SummaryToolCallRef[];
    nextIndex: number;
};
export declare function normalizeSummaryToolCallRefs(details: unknown): SummaryToolCallRef[];
export declare function formatSummaryToolCallRefs(refs: SummaryToolCallRef[]): string;
export declare function makeSummaryDetails(batch: CapturedBatch, refs: SummaryToolCallRef[]): {
    toolCallRefs: SummaryToolCallRef[];
    toolNames: string[];
    turnIndex: number;
    timestamp: number;
};
/**
 * Rewrites line-leading `[[N:name]]` labels emitted by the summarizer into
 * inline `` `tN` `` refs. `refs` and `toolNames` are positionally aligned to
 * the batch's tool-call order. The echoed name is validated against the tool
 * at position N; a mismatch or out-of-range N strips the label (footer-only).
 * A catch-all strip pass on non-fenced lines removes any surviving well-formed
 * label token (wrapped, numbered, or blockquoted) so no raw `[[N:name]]` token
 * ever leaks into context; fenced code blocks remain exempt.
 */
export declare function substituteInlineRefs(text: string, refs: SummaryToolCallRef[], toolNames: string[]): string;
