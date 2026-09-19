import { type CompactionResult, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { type LatestNativeCompactionResolution } from "./details-store.ts";
import { type ResponsesInputItem, type SerializeResponsesMessagesOptions } from "./serializer.ts";
import { type NativeCompactionEntry } from "../compaction/types.ts";
import type { AdapterState } from "../activation/state.ts";
export declare function resolveOpaqueNativeCompactionFallbackEntry(branchEntries: readonly SessionEntry[], runtime: {
    provider: string;
    api: string;
    baseUrl: string;
}): NativeCompactionEntry | undefined;
export declare function buildNativeCompactionInput(args: {
    model: Model<Api>;
    branchEntries: SessionEntry[];
    allEntries: SessionEntry[];
    leafId?: string | null | undefined;
    latestNativeCompaction: LatestNativeCompactionResolution;
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): {
    input: ResponsesInputItem[];
    compactedKeptWindow: boolean;
} | undefined;
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
export declare function injectPendingNativeWindowIntoPiCompactionRequest(payload: unknown, ctx: ExtensionContext, state: AdapterState): Promise<unknown | undefined>;
