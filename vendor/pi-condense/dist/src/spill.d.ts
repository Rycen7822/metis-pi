import type { CapturedBatch, CapturedToolCall } from "./types.js";
import type { ToolCallIndexer } from "./indexer.js";
/** Import the execution layer's full output, not its truncated display text. */
export declare function importOutputArchive(call: CapturedToolCall, sessionDir: string, sessionId: string): Promise<boolean>;
/** OCC archive preparation retains nested fusion receipts without publishing pruning. */
export declare function archiveToolOutput(call: CapturedToolCall, batch: CapturedBatch, args: {
    indexer: ToolCallIndexer;
    sessionDir: string;
    sessionId: string;
    appendEntry: (customType: string, data?: unknown) => void;
}): Promise<void>;
/** Replace anything outside [A-Za-z0-9_-] so the id can't escape the blob dir. */
export declare function sanitizeId(toolCallId: string): string;
export declare function blobDirFor(sessionDir: string, sessionId: string): string;
export declare function blobPathFor(sessionDir: string, sessionId: string, toolCallId: string): string;
/** Head of `text` capped at `maxBytes` (UTF-8 safe), preferring a line boundary. */
export declare function headPreview(text: string, maxBytes: number): string;
interface SpillConfig {
    spillThreshold: number;
    spillPreviewBytes: number;
    dedupByContentHash: boolean;
}
interface SpillableRecord {
    toolName: string;
    resultText: string;
    spillBytes?: number;
    resultPreview?: string;
    spillPath?: string;
    contentHash?: string;
}
/** Mutates `record` in place: spillBytes/resultPreview/spillPath/contentHash set, resultText emptied. */
export declare function applySpill(record: SpillableRecord, spillPath: string, previewBytes: number): void;
export declare function spillOversizedBatch(args: {
    batch: CapturedBatch;
    indexer: ToolCallIndexer;
    config: SpillConfig;
    sessionDir: string;
    sessionId: string;
    appendEntry: (customType: string, data?: unknown) => void;
}): Promise<Set<string>>;
export {};
