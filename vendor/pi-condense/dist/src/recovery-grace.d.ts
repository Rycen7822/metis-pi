/**
 * Set of `context_tree_query` occurrence keys (or bare ids when the message
 * carries no timestamp) still inside the recovery grace window, computed
 * positionally from the message array (no stored metadata).
 *
 * Keyed by occurrence, not bare id: the pruner's fail-closed ladder in
 * `pruneMessages` looks this set up with the SAME `occKey(id, timestamp)` it
 * computed for the message under test, so a graced occurrence never leaks
 * protection onto a different, later occurrence that happens to reuse the
 * same provider id.
 *
 * A recovery output's "user-turn-group" is the count of `role === "user"`
 * messages at or before its position; its age is `nowUTG - that count`, where
 * `nowUTG` is the total user messages in the array. It is in grace while
 * `age <= graceTurns`. Works uniformly for render-context and session-branch
 * arrays, so pruner Phase 1 and chain-compressor eligibility share one rule.
 *
 * `graceTurns <= 0` returns an empty set (feature disabled).
 */
export declare function inGraceRecoveryToolCallIds(messages: any[], graceTurns: number): Set<string>;
