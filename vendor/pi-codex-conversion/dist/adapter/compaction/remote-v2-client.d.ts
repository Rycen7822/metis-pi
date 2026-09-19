import { type Context, type Transport } from "@earendil-works/pi-ai";
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
export type ExecuteRemoteCompactionV2Options = {
    runtime: NativeCompactionRuntime;
    modelRegistry: ModelRegistry;
    context: Context;
    promptInput: readonly ResponsesInputItem[];
    requestOptions: NativeCompactionRequestOptions;
    tokensBefore: number;
    sessionId: string;
    signal?: AbortSignal | undefined;
    transport?: Transport | undefined;
    retryDelayMs?: number | undefined;
    promptInputSource?: "canonical" | "reconstructed" | undefined;
    compactionDiagnostic?: CodexCompactionDiagnostic | undefined;
    rewritePayload?: ((payload: unknown) => unknown) | undefined;
};
export declare function executeRemoteCompactionV2(options: ExecuteRemoteCompactionV2Options): Promise<RemoteCompactionV2Result>;
