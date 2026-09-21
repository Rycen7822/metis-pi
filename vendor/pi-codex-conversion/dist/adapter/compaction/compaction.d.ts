import { type CompactionResult, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Api, type Model, type Tool } from "@earendil-works/pi-ai";
import { type LatestNativeCompactionResolution } from "./details-store.ts";
import { type ResponsesCompatibleRequestPayload } from "./compaction-runtime.ts";
import { type ResponsesInputItem, type SerializeResponsesMessagesOptions } from "./serializer.ts";
import { type NativeCompactionEntry } from "../compaction/types.ts";
import type { AdapterState, PendingPiCompactionNativeWindow } from "../activation/state.ts";
export declare function resolveOpaqueNativeCompactionFallbackEntry(branchEntries: readonly SessionEntry[], runtime: {
    provider: string;
    api: string;
    baseUrl: string;
}): NativeCompactionEntry | undefined;
/** A checkpoint build either produces a request history or names why it cannot. */
export type NativeCompactionInputResult = {
    ok: true;
    input: ResponsesInputItem[];
    compactedKeptWindow: boolean;
    tools: Tool[];
    checkpointReused: boolean;
} | {
    ok: false;
    reason: "first-kept-entry-not-found" | "invalid-compacted-window";
};
export declare function buildNativeCompactionInput(args: {
    model: Model<Api>;
    branchEntries: SessionEntry[];
    allEntries: SessionEntry[];
    leafId?: string | null | undefined;
    latestNativeCompaction: LatestNativeCompactionResolution;
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): NativeCompactionInputResult;
export declare function resolveCanonicalCompactionReplay(args: {
    codeMode: boolean;
    sessionId: string;
    model: string;
    identity?: {
        url: string;
        accountId: string;
    } | undefined;
    reconstructedInput: readonly ResponsesInputItem[];
}): Promise<{
    input?: unknown[] | undefined;
    decision: import("./diagnostics.ts").CodexCompactionReplayDecision;
}>;
export declare function handleCodexSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, state: AdapterState, pi: ExtensionAPI): Promise<{
    cancel: boolean;
    compaction?: never;
} | {
    compaction: CompactionResult<unknown>;
    cancel?: never;
} | undefined>;
export declare function rewriteCodexCompactedProviderRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined>;
/** How a summarization request boundary handled the window it was offered. */
export type NativeWindowInjectionResult = 
/** The request now carries the window. */
{
    status: "injected";
    payload: ResponsesCompatibleRequestPayload;
}
/** No window, not the summarization request, or no runtime yet: nothing was consumed. */
 | {
    status: "not-applicable";
}
/** The window does not belong to this session, endpoint, or source checkpoint. */
 | {
    status: "rejected";
    reason: "session-mismatch" | "endpoint-mismatch" | "source-checkpoint-invalid";
};
/**
 * Insert a previously selected opaque window into a Pi summarization request. The caller owns the
 * window's lifetime: it passes the snapshot it wants injected and clears its own state from the
 * returned status. A window selected before an awaited summary started is re-resolved here, so
 * edits or a newer checkpoint that appeared meanwhile cannot leak stale content into the request.
 */
export declare function injectNativeWindowIntoPiCompactionRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState, window: PendingPiCompactionNativeWindow | undefined): Promise<NativeWindowInjectionResult>;
