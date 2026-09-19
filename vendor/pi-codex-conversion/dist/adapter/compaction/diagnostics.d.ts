export type CodexCompactionInputSource = "canonical" | "reconstructed";
export type CodexCompactionContinuation = "disabled" | "no_session_cache_entry" | "no_continuation" | "body_mismatch" | "input_shorter_than_baseline" | "input_prefix_mismatch" | "missing_previous_response_id" | "delta";
export type CodexCompactionReplayDecision = "validated" | "not_applicable" | "no_state" | "model_mismatch" | "identity_mismatch" | "input_shorter_than_baseline" | "request_prefix_mismatch" | "response_prefix_mismatch";
export type CodexCompactionDiagnostic = {
    model?: string | undefined;
    inputSource: CodexCompactionInputSource;
    canonicalReplay: CodexCompactionReplayDecision;
    checkpointReused: boolean;
    checkpointModel?: string | undefined;
    transport?: "websocket" | "sse" | undefined;
    continuation?: CodexCompactionContinuation | undefined;
    previousResponseId?: boolean | undefined;
    fullInputItems?: number | undefined;
    sentInputItems?: number | undefined;
    rewrittenToolOutputs?: number | undefined;
};
export declare function isCodexCompactionDiagnostic(value: unknown): value is CodexCompactionDiagnostic;
export declare const COMPACTION_CACHE_DIAGNOSTIC_THRESHOLD = 0.8;
export declare function formatCompactionCacheDiagnostic(usage: {
    inputTokens: number;
    cachedInputTokens: number;
}, diagnostic: CodexCompactionDiagnostic | undefined): string | undefined;
