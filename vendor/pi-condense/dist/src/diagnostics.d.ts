import type { DiagnosticKind } from "./types.js";
/**
 * Out-of-band diagnostic channel for prune-time degradations. Session entries
 * only - never LLM context, so zero tokens and zero cache-prefix change.
 * Deduped per (kind, dedupKey) so a permanently degraded condition writes one
 * entry, not one per render.
 */
export declare class DiagnosticSink {
    private readonly appendEntry;
    private readonly seen;
    private readonly counters;
    constructor(appendEntry: (customType: string, data?: unknown) => void);
    report(kind: DiagnosticKind, dedupKey: string, detail: string): void;
    counts(): Record<DiagnosticKind, number>;
    /** Clears session-scoped state; call on session_start/session_tree since this sink is process-scoped, not session-scoped. */
    reset(): void;
}
