import { type Tool, type Transport } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { NativeCompactionRuntime } from "./compaction-runtime.ts";
import type { NativeCompactionRequestOptions, ResponsesInputItem } from "./serializer.ts";
import type { CodexCompactionDiagnostic } from "./diagnostics.ts";
export type RemoteCompactionV2Result = {
    ok: true;
    compaction: Record<string, unknown>;
    responseId: string;
    createdAt: string;
    usage?: RemoteCompactionV2Usage | undefined;
} | {
    ok: false;
    reason: "aborted" | "unavailable" | "stream-error" | "invalid-output";
    errorMessage: string;
    status?: number | undefined;
};
export type RemoteCompactionV2Usage = {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    diagnostic?: CodexCompactionDiagnostic | undefined;
};
/**
 * The replayed transcript for a native compaction request: the history items together with the
 * top-level tools of the same placement decision that produced them. Keeping them in one value is
 * what prevents a request from declaring the current tool set at the top level while the history
 * announces those same tools in place.
 */
export type NativeCompactionHistory = {
    input: readonly ResponsesInputItem[];
    tools: readonly Tool[];
};
export type ExecuteRemoteCompactionV2Options = {
    runtime: NativeCompactionRuntime;
    modelRegistry: ModelRegistry;
    /** The replayed transcript; `systemPrompt` is the prompt it belongs to. */
    history: NativeCompactionHistory;
    systemPrompt: string;
    requestOptions: NativeCompactionRequestOptions;
    tokensBefore: number;
    sessionId: string;
    /** Validated canonical history; when set, the request replays the canonical baseline instead. */
    canonicalInput?: readonly ResponsesInputItem[] | undefined;
    signal?: AbortSignal | undefined;
    transport?: Transport | undefined;
    retryDelayMs?: number | undefined;
    compactionDiagnostic?: CodexCompactionDiagnostic | undefined;
    rewritePayload?: ((payload: unknown) => unknown) | undefined;
};
export declare function executeRemoteCompactionV2(options: ExecuteRemoteCompactionV2Options): Promise<RemoteCompactionV2Result>;
