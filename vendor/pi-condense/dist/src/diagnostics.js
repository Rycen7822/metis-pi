import { CUSTOM_TYPE_DIAGNOSTIC } from "./types.js";
/**
 * Out-of-band diagnostic channel for prune-time degradations. Session entries
 * only - never LLM context, so zero tokens and zero cache-prefix change.
 * Deduped per (kind, dedupKey) so a permanently degraded condition writes one
 * entry, not one per render.
 */
export class DiagnosticSink {
    appendEntry;
    seen = new Set();
    counters = {
        "unresolved-range": 0,
        "range-id-mismatch": 0,
        "orphan-sweep": 0,
        "backfill-empty": 0,
    };
    constructor(appendEntry) {
        this.appendEntry = appendEntry;
    }
    report(kind, dedupKey, detail) {
        const key = `${kind}:${dedupKey}`;
        if (this.seen.has(key))
            return;
        const payload = { kind, detail };
        try {
            this.appendEntry(CUSTOM_TYPE_DIAGNOSTIC, payload);
        }
        catch (err) {
            // The render path must never fail because bookkeeping failed.
            console.error(`pruner: failed to persist ${kind} diagnostic:`, err);
            return;
        }
        this.seen.add(key);
        this.counters[kind]++;
    }
    counts() {
        return { ...this.counters };
    }
    /** Clears session-scoped state; call on session_start/session_tree since this sink is process-scoped, not session-scoped. */
    reset() {
        this.seen.clear();
        for (const kind of Object.keys(this.counters)) {
            this.counters[kind] = 0;
        }
    }
}
