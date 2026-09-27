import type { ToolCallIndexer } from "./indexer.js";
import type { ChainCompressionConfig, ErrorPurgeConfig } from "./types.js";
import { type ProtectionConfig } from "./protected.js";
import type { DiagnosticSink } from "./diagnostics.js";
import { type SupersedeState } from "./supersede.js";
/**
 * Estimate of a message array's context weight. Serializing the whole array
 * (not just visible text) is deliberate: it counts tool-call argument bodies
 * (error-purge) and tool-result arrays (stub-replace / chain-range) so all
 * reclaim mechanisms register.
 */
export declare function sizeMessages(messages: any[]): number;
/**
 * Transforms the `context` event message array in five phases:
 *
 * Phase 1 — stub-replace: ToolResultMessages for summarized tool calls are
 * replaced with short stubs pointing the model at `context_tree_query`.
 *
 * Why stubs instead of dropping the message entirely:
 *   - Dropping orphans the matching `toolCall` block inside the
 *     preceding AssistantMessage. pi-ai's `transformMessages` then
 *     injects a synthetic `{ role: "toolResult", isError: true,
 *     content: "No result provided" }` for every orphan, which the LLM
 *     reads as a real tool failure. Replacing the toolResult with a
 *     stub keeps role alternation intact and suppresses that injection.
 *   - The stub carries the short ref (`tN`) the model can pass to
 *     `context_tree_query` to recover the raw output, so the breadcrumb
 *     to recovery is present on the toolResult itself, not only in the
 *     separate summary message.
 *
 * Phase 1b — supersede: protected reads (never indexed) whose `args.path`
 * is read again later in the same context are replaced with a one-line
 * "superseded" stub, but only once `SupersedeState.floor` says the pruner
 * is rewriting at/before their position anyway (or the cache is cold).
 * See src/supersede.ts. Runs before phase 3 so a superseded read inside a
 * compressed chain relocates as the stub, not the verbatim body.
 *
 * Phase 2 — error purge: replaces failed toolCall arg bodies with stubs after a
 * cooldown, reclaiming context from large `write`/`edit` arguments that will
 * never succeed. The toolResult error message stays visible.
 *
 * Phase 3 — chain range prune: closed chains older than the rolling window
 * are dropped (middle assistant + toolResult messages) and replaced with a
 * synthetic user message wrapping the existing per-batch summary text.
 * Only runs when `chainCompression.enabled` and chain entries exist.
 *
 * Phase 4 — orphan sweep: structural post-condition run unconditionally over
 * the final array. Removes any toolResult whose matching toolCall id is not
 * open: opened by the most recent assistant turn and uninterrupted by a
 * barrier (any non-assistant/non-toolResult message) — see
 * src/orphan-sweep.ts. Reference-preserving when nothing is swept, so a
 * clean render still returns the identical input array.
 *
 * Return shape:
 *   - `pruned: true`  — at least one change happened; the returned
 *     `messages` is a freshly allocated array.
 *   - `pruned: false` — nothing matched; the returned `messages` is the
 *     **original input array reference** so the caller can cheaply skip
 *     the reconstruction path.
 *   - `beforeChars` / `afterChars` — serialized context size (`sizeMessages`)
 *     before and after pruning when `pruned` is true. When `pruned` is false
 *     both are `0`: a no-op sentinel, not a measurement — the size is never
 *     computed on the no-op path (zero `JSON.stringify` over the array), and
 *     the only consumer (`index.ts` live-reclaim) reads them solely under
 *     `if (result.pruned)`.
 *
 * AssistantMessage tool-call blocks (which carry the IDs) are kept
 * unchanged so the model can still reference them by id when calling
 * `context_tree_query`.
 */
export declare function pruneMessages(messages: any[], indexer: ToolCallIndexer, chainCompression?: ChainCompressionConfig, errorPurge?: ErrorPurgeConfig, protection?: ProtectionConfig, recoveryGraceTurns?: number, diagnostics?: DiagnosticSink, supersede?: {
    state: SupersedeState;
    isProtected: (toolName: string, args: unknown) => boolean;
}, editedToolIds?: ReadonlySet<string>): {
    messages: any[];
    pruned: boolean;
    beforeChars: number;
    afterChars: number;
};
