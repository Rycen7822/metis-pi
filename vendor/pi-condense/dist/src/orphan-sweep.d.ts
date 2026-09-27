/**
 * pi-ai repairs orphan tool calls only; providers reject orphan tool results.
 *
 * Open-call tracking is PER TURN: an assistant message replaces the open set
 * with its own toolCall ids, and any message that is neither assistant nor
 * toolResult is a barrier that clears it (matching where pi-ai flushes
 * synthetic tool results). A cumulative seen-set would let an id used
 * validly in an early turn license a later genuine orphan - exactly the
 * id-collision case this exists for.
 *
 * Returns the input array reference when nothing is swept, preserving the
 * no-op / prompt-cache-prefix invariant of
 * doc/specs/2026-08-04-pruner-noop-serialization.md.
 */
export declare function sweepOrphanToolResults(messages: any[]): {
    messages: any[];
    sweptIds: string[];
};
