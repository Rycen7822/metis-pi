import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResponsesCompatibleRequestPayload } from "../compaction/compaction-runtime.ts";
import type { NativeCompactionEntry } from "../compaction/types.js";
import { type DeferredToolPlacement } from "../../providers/openai-responses/shared.ts";
import { type ResponsesInputItem, type ResponsesInputMessageItem, type SerializeResponsesMessagesOptions } from "../compaction/serializer.js";
import { type SerializedReplaySlice } from "./native-replay-matching.ts";
export type NativeReplaySegments = {
    boundaryIndex: number;
    firstKeptEntryIndex: number;
    instructions?: string | undefined;
    freshPreamble: ResponsesInputMessageItem[];
    trailingPreamble: ResponsesInputMessageItem[];
    compactionSummary: ResponsesInputItem[];
    preCompactionKeptWindow: SerializedReplaySlice;
    compactedWindow: unknown[];
    postCompactionTail: SerializedReplaySlice;
    originalPiReplayInput: ResponsesInputItem[];
    replayInput: unknown[];
};
export type NativeReplayPayloadRewrite = {
    ok: true;
    segments: NativeReplaySegments;
    rewrittenPayload: ResponsesCompatibleRequestPayload;
};
export type NativeReplayPayloadRewriteFailureReason = "compaction-boundary-not-found" | "first-kept-entry-not-found" | "context-edit-targets-compacted-content" | "unsupported-instructions" | "invalid-compacted-window" | "unexpected-compaction-after-boundary" | "expected-pi-replay-mismatch";
export type NativeReplayPayloadRewriteFailure = {
    ok: false;
    reason: NativeReplayPayloadRewriteFailureReason;
    parity?: {
        actual: string[];
        expected: string[];
        mismatches: string[];
    } | undefined;
};
export type NativeReplayPayloadRewriteResult = NativeReplayPayloadRewrite | NativeReplayPayloadRewriteFailure;
export declare function findCompactionBoundaryIndex(entries: readonly SessionEntry[], compactionEntryId: string): number | undefined;
export declare function serializeLiveTailToResponsesInput<TApi extends Api>(args: {
    model: Model<TApi>;
    entries: readonly SessionEntry[];
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): ResponsesInputItem[];
/**
 * Placement for every tool in the transcript a checkpoint will replay: the stored system message
 * plus the kept window and the live tail. One decision keeps all slices of that transcript aligned
 * with the payload the provider built from it.
 */
/**
 * Tool placement for a transcript a checkpoint replays: its stored system message leads, the given
 * entries follow. Both the replay rewrite and the reconstructed compaction request decide through
 * here, so a transcript assembled in pieces has exactly one placement.
 */
export declare function resolveReplayedToolPlacement<TApi extends Api>(args: {
    model: Model<TApi>;
    checkpointSystemMessage?: NativeCompactionEntry["systemMessage"] | undefined;
    entries: readonly SessionEntry[];
}): DeferredToolPlacement;
export declare function buildNativeReplaySegments<TApi extends Api>(args: {
    model: Model<TApi>;
    payload: ResponsesCompatibleRequestPayload;
    branchEntries: readonly SessionEntry[];
    compactionEntry: NativeCompactionEntry;
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeReplayPayloadRewriteResult;
export declare function rewriteResponsesPayloadWithNativeReplay<TApi extends Api>(args: {
    model: Model<TApi>;
    payload: ResponsesCompatibleRequestPayload;
    branchEntries: readonly SessionEntry[];
    compactionEntry: NativeCompactionEntry;
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeReplayPayloadRewriteResult;
