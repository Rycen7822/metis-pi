import type { Usage } from "@earendil-works/pi-ai";
import type { SummaryBudgetPolicy } from "./budget.ts";
import { defaultMetisConfig, decodePruneConfig } from "../metis-config.ts";
/**
 * Shared types for the context-prune extension.
 *
 * Design decisions (Phase 1):
 *
 * SUMMARIZATION BATCH (Ph1 step 2):
 *   One batch = one completed assistant turn with tool calls, captured from
 *   the `turn_end` event when event.toolResults.length > 0.
 *   event.message = AssistantMessage (contains ToolCall content blocks with ids)
 *   event.toolResults = ToolResultMessage[] (one per tool call in this turn)
 *
 * STATE MODEL (Ph1 step 3):
 *   - Runtime state: Map<occurrenceKey, ToolCallRecord> rebuilt on session_start
 *   - Session metadata: pi.appendEntry("context-prune-index", IndexEntryData)
 *     stored once per summarized batch; NOT in LLM context
 *   - User config: global metis-pi.toml → [contextPrune], owned by metis-config.ts
 *
 * CONFIG FORMAT (Ph1 step 4):
 *   { "contextPrune": { "enabled": false, "summarizerModel": "default", "showPruneStatusLine": true } }
 *   summarizerModel: "default" = use current active model (ctx.model)
 *                   "provider/model-id" = explicit model via ctx.modelRegistry.find()
 *
 * SUMMARY MESSAGE FORMAT (Ph1 step 5):
 *   customType: "context-prune-summary"
 *   content: markdown with one bullet per tool call + short-id footer
 *   details: SummaryMessageDetails (toolCallRefs, toolNames, turnIndex, timestamp)
 *   The content itself includes short alias IDs in plain text so the model can
 *   reference them in future context_tree_query calls without needing details.
 *
 * API CONSTRAINTS (Ph1 step 6):
 *   - Pruning MUST happen in the `context` event via { messages: filtered },
 *     never by mutating session history (pi.appendEntry / session file untouched)
 *   - Summary injection uses pi.sendMessage(..., { deliverAs: "steer" }) from
 *     inside the turn_end handler so it lands before the next LLM call
 *   - Original full tool outputs are preserved in IndexEntryData (session custom
 *     entries) and accessible via context_tree_query at any time
 *   - v1 prunes only ToolResultMessage entries; the AssistantMessage tool-call
 *     blocks (which carry the toolCallIds) are intentionally kept so the model
 *     can still reference them when calling context_tree_query
 *   - "default" summarizer = ctx.model (current active model + its credentials),
 *     NOT a hidden side-channel. It makes an explicit LLM call from turn_end.
 */

import type { FallbackController } from "./summarizer-fallback.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** customType for summary custom_message entries (appear in LLM context) */
export const CUSTOM_TYPE_SUMMARY = "context-prune-summary";

/** customType for index persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_INDEX = "context-prune-index";

/** customType for stats persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_STATS = "context-prune-stats";

/** customType for prune-frontier persistence entries (NOT in LLM context) */
export const CUSTOM_TYPE_FRONTIER = "context-prune-frontier";

/**
 * customType for content-hash dedup alias entries (NOT in LLM context).
 *
 * One entry per duplicate tool call detected by the pre-flush dedup pass.
 * The new toolCallId is registered as an alias of an already-indexed
 * original toolCallId. The original's record (in CUSTOM_TYPE_INDEX) is
 * the source of truth for the result text. See
 * src/content-hash.ts and src/indexer.ts for the dedup machinery.
 */
export const CUSTOM_TYPE_DEDUP_ALIAS = "context-prune-dedup-alias";

/**
 * customType for chain-compression entries (NOT in LLM context).
 *
 * One entry per closed chain that has been range-dropped from LLM context.
 * Rebuilt on `session_start` to repopulate the chain registry.
 * Written by `chain-compressor.compressEligible` at the tail of `flushPending` and via `/pruner compact`.
 */
export const CUSTOM_TYPE_CHAIN = "context-prune-chain";

/**
 * Written via pi.appendEntry(CUSTOM_TYPE_DIAGNOSTIC, data) when a prune-time
 * invariant degrades. NOT in LLM context: zero tokens, zero cache-prefix
 * change. Deduplication is a runtime concern of the diagnostic sink
 * (src/diagnostics.ts), which takes a caller-supplied dedup key and never
 * persists it - the persisted entry carries only `kind` plus a freeform `detail`.
 */
export const CUSTOM_TYPE_DIAGNOSTIC = "context-prune-diagnostic";

/**
 * Per-flush-attempt observability record. Written once per non-concurrent
 * flushPending invocation, regardless of outcome (including "empty" and
 * "error"). Append-only log: never in LLM context, never reconstructed.
 */
export const CUSTOM_TYPE_FLUSH_METRICS = "context-prune-flush-metrics";

export type DiagnosticKind = "unresolved-range" | "range-id-mismatch" | "orphan-sweep" | "backfill-empty";

export interface DiagnosticEntryData {
  kind: DiagnosticKind;
  detail: string;
}

/** The registered name of the recovery tool (src/query-tool.ts). Shared so the
 * grace checks in pruner.ts / chain-compressor.ts cannot drift from registration. */
export const QUERY_TOOL_NAME = "context_tree_query";

/** Footer status widget ID */
export const STATUS_WIDGET_ID = "context-prune";

/**
 * Widget ID for the live /pruner now progress panel shown above the editor.
 */
export const PROGRESS_WIDGET_ID = "context-prune-progress";
// ── Config ─────────────────────────────────────────────────────────────────

/**
 * When summarization (and context pruning) is triggered.
 * - "agent-message" : batches up turns and flushes when the agent sends a final text response
 *                     (a turn with no tool calls), or when the agent loop ends (default)
 * - "on-demand"     : only when the user runs /pruner now
 */
export type PruneOn = "on-demand" | "agent-message";

/**
 * Granularity of pruning batches.
 * - "turn"          : keep assistant turns separate (default)
 * - "agent-message" : merge turns within one user task up to the input budget
 * Both modes split oversized turns into budget-bounded chunks.
 */
export type BatchingMode = "turn" | "agent-message";

/** Thinking/reasoning level requested for summarizer LLM calls. */
export type SummarizerThinking = "default" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Choices for the summarizer thinking setting (used by commands and settings overlay) */
export const SUMMARIZER_THINKING_LEVELS: { value: SummarizerThinking; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

/** Cycling presets for the `purgeErrors.cooldownTurns` setting. */
export const PURGE_COOLDOWN_PRESETS: { value: string; label: string }[] = [
  { value: "1", label: "1" },
  { value: "2", label: "2 (default)" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
];

/** Cycling presets for the `purgeErrors.minArgChars` setting. */
export const PURGE_MIN_ARG_PRESETS: { value: string; label: string }[] = [
  { value: "100", label: "100" },
  { value: "500", label: "500 (default)" },
  { value: "1000", label: "1000" },
  { value: "5000", label: "5000" },
];

/** Choices for the batching-mode setting (used by commands and settings overlay) */
export const BATCHING_MODES: { value: BatchingMode; label: string }[] = [
  { value: "turn", label: "Per turn" },
  { value: "agent-message", label: "Per agent message" },
];

/**
 * Cycling preset values for the `chainCompression.rollingWindow` setting.
 * Stored as strings because SettingsList cycles string values; converted to
 * number when applied.
 */
export const ROLLING_WINDOW_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3 (default)" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
];

/**
 * Cycling preset values for the `minBatchChars` setting in the SettingsList.
 * Stored as strings because SettingsList cycles string values; converted to
 * number when applied. `"0"` is the disabled sentinel.
 */
export const MIN_BATCH_CHARS_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0 (disabled)" },
  { value: "500", label: "500" },
  { value: "1000", label: "1000" },
  { value: "2000", label: "2000" },
  { value: "5000", label: "5000 (default)" },
];

/**
 * Cycling presets for the `recoveryGraceTurns` setting in the SettingsList.
 * Stored as strings; converted to number when applied. "0" disables the grace
 * (recovery output stubs immediately, pre-feature behavior).
 */
export const RECOVERY_GRACE_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0 (disabled)" },
  { value: "1", label: "1" },
  { value: "3", label: "3 (default)" },
  { value: "5", label: "5" },
  { value: "8", label: "8" },
];

/**
 * Cycling presets for `summarizerIdleTimeoutMs` (stored as strings; the
 * settings UI cycles string values). "0" is the disabling sentinel.
 */
export const SUMMARIZER_IDLE_TIMEOUT_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0 (disabled)" },
  { value: "10000", label: "10s" },
  { value: "20000", label: "20s (default)" },
  { value: "45000", label: "45s" },
  { value: "90000", label: "90s" },
];

/**
 * Cycling presets for `summarizerMaxTimeoutMs` (stored as strings). "0" is
 * the disabling sentinel - no total-duration ceiling.
 */
export const SUMMARIZER_MAX_TIMEOUT_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "0 (disabled)" },
  { value: "120000", label: "120s" },
  { value: "180000", label: "180s (default)" },
  { value: "300000", label: "300s" },
  { value: "600000", label: "600s" },
];

/**
 * Cycling presets for the `autoBudgetThreshold` setting (stored as strings;
 * the settings UI cycles string values). "0" is the disabled sentinel → null.
 * Other values are 0–1 fractions of the context window (e.g. "0.8" = flush at
 * 80% of the window, or at MAX_BUDGET_WINDOW tokens, whichever comes first).
 */
export const AUTO_BUDGET_PRESETS: { value: string; label: string }[] = [
  { value: "0", label: "Off" },
  { value: "0.6", label: "60%" },
  { value: "0.7", label: "70% (default)" },
  { value: "0.8", label: "80%" },
  { value: "0.9", label: "90%" },
];

/** Choices for the prune-on setting (used by commands and settings overlay) */
export const PRUNE_ON_MODES: { value: PruneOn; label: string }[] = [
  { value: "agent-message", label: "On agent message" },
  { value: "on-demand", label: "On demand" },
];

/** Global metis-pi.toml [contextPrune]; agent-dir honors PI_CODING_AGENT_DIR. */
export interface ContextPruneConfig {
  /** Advanced calibrated pressure/gain/output/soft-target policy; configuration-file only. */
  summaryBudget: SummaryBudgetPolicy;
  /** Opt in to shared rewrite buffering and ordinary-Pi opportunistic compaction. */
  opportunisticCompaction: boolean;
  /** Whether to prune raw tool outputs from future LLM context */
  enabled: boolean;
  /** Whether to show the prune footer status line and queued turn messages */
  showPruneStatusLine: boolean;
  /** Whether to show the persistent OCC footer status line */
  showOccStatusLine: boolean;
  /** Additional output-token ceiling for Pi compaction summaries; 0 keeps Pi's native limit. */
  compactionSummaryMaxTokens: number;
  /**
   * Which model to use for summarization.
   * "default" = current active Pi model (ctx.model)
   * "provider/model-id" = explicit model (e.g. "anthropic/claude-haiku-3-5")
   */
  summarizerModel: string;
  /** Ordered provider/model-id outage fallbacks; the session model is always last. */
  summarizerFallbackModels: string[];
  /** Thinking/reasoning level to request for summarizer calls. */
  summarizerThinking: SummarizerThinking;
  /** When to trigger summarization and pruning */
  pruneOn: PruneOn;
  /**
   * Granularity of each pruning batch.
   * - "turn"          : keep assistant turns separate (default)
   * - "agent-message" : merge within one user task up to the input budget
   * Both modes split oversized turns.
   */
  batchingMode: BatchingMode;
  /**
   * Suppress the UI notification emitted when a batch is skipped — for either
   * reason: (a) the summary would have been larger than the raw tool-result
   * text (oversized), or (b) the batch was below `minBatchChars` and never
   * sent to the summarizer (trivial). The frontier still advances in both
   * cases; only the notification is silenced. Useful for sessions dominated
   * by small tool calls where one or both fire on nearly every turn.
   */
  quietOversizedSkips: boolean;
  /**
   * Pre-flush guard. If the total raw `resultText` character count across all
   * tool calls in a batch is below this threshold, the batch is skipped: no
   * summarizer LLM call is made, no index entry is written, no summary
   * message is injected, and the prune frontier advances past the batch so
   * the same tool calls are not reconsidered on the next flush.
   *
   * Rationale: a short summary like "Tool X did Y" can already be 50–150
   * chars per call. For very small batches (e.g. a 200-byte file read) the
   * summary is near-identical in size or even larger than the raw input, so
   * calling the LLM is wasted cost. The existing post-call `skipped-oversized`
   * mechanism catches this AFTER the LLM round-trip; `minBatchChars` catches
   * the obvious cases BEFORE it, at zero LLM cost.
   *
   * Set to `0` to disable only the character guard. Token gain and pressure
   * admission still apply; it does not force a model request.
   *
   * Default: 5000.
   */
  minBatchChars: number;
  /**
   * User-turn-groups a `context_tree_query` (recovery) output stays verbatim in
   * context after recovery, before it reverts to the normal stub. Bounds the
   * retrieve->re-stub->re-query loop without permanent retention. 0 disables
   * (recovery output stubs immediately). Enforced at render time in pruner.ts
   * (Phase 1) and chain-compressor.ts (eligibility), not at capture.
   */
  recoveryGraceTurns: number;
  /**
   * Idle (inactivity) timeout for a single summarizer stream call, in ms.
   * Reset on every received stream event; armed before the first event so it
   * also bounds time-to-first-token. If no event arrives within this window
   * the call is aborted and classified transient (feeds the outage-fallback
   * retry). 0 disables the idle timer. Default 20000.
   */
  summarizerIdleTimeoutMs: number;
  /**
   * Total-duration ceiling for a single summarizer stream call, in ms. Armed
   * once at call start, never reset - a hard upper bound catching a stream
   * that keeps dribbling events but never completes. Same transient/warning
   * handling as the idle timeout. 0 disables the ceiling. Default 180000.
   */
  summarizerMaxTimeoutMs: number;
  /**
   * Tool names whose outputs must NEVER be pruned or summarized. Tool calls
   * with matching `toolName` are filtered out of the pruning capture path so
   * their original `ToolResultMessage` stays verbatim in future LLM context.
   *
   * Use for tools whose raw output the agent must keep reading verbatim
   * across turns — for example `todowrite` / `todoread` carrying plan state,
   * or any tool returning a structured handle the agent expects to find
   * unchanged later.
   *
   * Default is `[]` (empty) so behavior is preserved for existing configs and
   * we do not assume which skill-provided tools (e.g. todo*) the user has
   * loaded. Users opt in via `/pruner protected-tools` or the settings file.
   *
   * Matched names are compared by exact tool name; missing / typoed names
   * are silently ignored (they simply never match any captured tool call).
   */
  protectedTools: string[];
  /**
   * Glob patterns matched against a tool call's `args.path`. Matching calls are
   * protected with identical semantics to protectedTools. Default protects
   * skill files and their sibling reference docs under any `skills/` dir,
   * plus per-repo `gauntlet-overrides.md` files.
   * Kill switch: set protectedPaths = [] in global metis-pi.toml [contextPrune].
   */
  protectedPaths: string[];
  /** Chain-level range compression for old closed chains beyond the rolling window. */
  chainCompression: ChainCompressionConfig;
  /** Replace failed toolCall argument bodies with compact stubs after a cooldown window. */
  purgeErrors: ErrorPurgeConfig;
  /**
   * Exact SHA-256 (toolName, resultText) identity against previously covered
   * records; whitespace is not normalized. Each duplicate keeps its own
   * durable recovery ref, arguments, status and timestamp. Its actual stub
   * must shrink the local model-facing proxy before hiding is authorized.
   * Archive-only records never seed dedup. No intra-flush dedup or model call.
   * Default true; false keeps duplicate raw outputs inline.
   */
  dedupByContentHash: boolean;
  /**
   * Automatic paid-summary pressure gate, fraction in (0, 1]. The first of
   * threshold * model window, 300000 tokens, or Pi-resolved native capacity
   * minus 16384 growth headroom admits evaluation (still subject to OCC and
   * the net-benefit/output budget). On-demand evaluates at tool-turn triggers;
   * agent-message evaluates at the final reply or a later request retry.
   * Default 0.7; explicit null disables automatic paid summaries, not
   * mechanical pruning, manual summaries or Pi's native capacity guard.
   * Invalid values normalize to the default.
   */
  autoBudgetThreshold: number | null;
  /** Min chars (resultText.length) for a single tool result to spill to a sidecar file. */
  spillThreshold: number;
  /** Head-preview size in bytes kept inline as resultPreview on a spilled record. */
  spillPreviewBytes: number;
  /**
   * Per-turn usage-fraction increase (0–1) that triggers a flush evaluation.
   * Paid generation still requires autoBudgetThreshold pressure admission. The fraction is measured against the effective window
   * `min(contextWindow, MAX_BUDGET_WINDOW)` (300_000), so the required growth is
   * `delta * min(contextWindow, MAX_BUDGET_WINDOW)` tokens - e.g. 0.1 means +30k
   * tokens in one turn on any model at or above 300k, and +20k on a 200k model.
   * null (default) = disabled. Out-of-range (<= 0 or > 1) normalizes to null.
   */
  budgetTurnDelta: number | null;
  /**
   * Opt-in flush trigger: when the un-pruned tail past the frontier
   * (frontierGapTokens) reaches this many tokens, evaluate at turn_end.
   * This does not bypass paid-summary pressure/net-benefit admission.
   * null (default) disables. Config-file-only — no settings overlay row.
   */
  frontierGapThresholdTokens: number | null;
  /**
   * Request-validity guard: keep only the newest N image blocks in each
   * outgoing request and replace older ones with a text note, so a long
   * session never exceeds a provider's per-request image limit. Applies even
   * when `enabled` is false. null (default) uses the built-in limit for the
   * model's API (`anthropic-messages`: 100; other APIs: no cap).
   * Config-file-only.
   */
  maxImagesPerRequest: number | null;
}

/**
 * Detected (pre-decision) shape emitted by chain-detector.
 * Distinct from ChainCompressionEntry (the persisted post-decision shape).
 *
 * NOTE: AgentMessage has no `.id` field, so chains are identified by
 * `timestamp` (for user/final-assistant boundaries) and `toolCallId` sets
 * (for middle tool-using turns). The chain-compressor promotes ChainRange
 * into a ChainCompressionEntry by adding blockId, toolRefs, and compressedAt.
 */
export interface ChainRange {
  /**
   * Start anchor timestamp — a user message or an eligible (non-pruner)
   * custom message. Field name kept for persisted-entry compatibility.
   */
  startUserTimestamp: number;
  /**
   * All toolCallIds in the chain's middle (deduplicated). Collected from both
   * AssistantMessage ToolCall blocks AND matching ToolResultMessages.
   * Identifies the chain's middle tool calls for detection, recovery-grace
   * filtering and diagnostics. NOT used for the load-bearing indexer lookups
   * (summary bodies, tool refs) - those maps are occurrence-keyed, so use
   * the sibling `middleOccurrenceKeys` instead. Drops themselves are decided
   * positionally by `resolveRange` in chain-range-prune.ts, not by these ids.
   */
  middleToolCallIds: string[];
  /**
   * Occurrence keys (`id@resultTimestamp`) for the chain's middle tool
   * results, collected from the ToolResultMessages themselves. Used for
   * indexer summary-body / toolRef lookups, which are occurrence-keyed.
   * Optional so hand-built ChainRange fixtures need not set it.
   */
  middleOccurrenceKeys?: string[];
  /**
   * Subset of middleToolCallIds whose tool name ∈ protectedTools (detection-time
   * fact). The detector always emits it ([] when no protected tool ran); optional
   * so hand-built ChainRange fixtures need not set it.
   */
  protectedToolCallIds?: string[];
  /** Timestamp of the final text-only assistant message, or null if truncated/open. */
  finalAssistantTimestamp: number | null;
}

/**
 * Persisted per chain that has been range-dropped from LLM context.
 * Written via pi.appendEntry(CUSTOM_TYPE_CHAIN, entry).
 * Rebuilt into the chain registry on session_start.
 */
export interface SingleChainCompressionEntry {
  /** Semantic bodies used to build this entry; later summaries invalidate it. */
  summaryFingerprint?: string;
  /** Stable block ID, monotonic per session: "b1", "b2", ... */
  blockId: string;
  /**
   * Start anchor timestamp — a user message or an eligible (non-pruner)
   * custom message. Field name kept for persisted-entry compatibility.
   * Keep raw; synthetic inserted after.
   */
  startUserTimestamp: number;
  /**
   * All toolCallIds in the chain's middle. **Diagnostic only** since the
   * positional-range change: drops are decided by index range (see
   * resolveRange in chain-range-prune.ts). Retained as a cross-check - a
   * mismatch against the ids actually dropped emits `range-id-mismatch`.
   */
  droppedToolCallIds: string[];
  /**
   * Occurrence keys for the same calls as droppedToolCallIds. Load-bearing at
   * render time: summaryBodies are occurrence-keyed, so the synthetic chain
   * body is looked up by these. Absent on pre-upgrade entries, which fall back
   * to droppedToolCallIds against their own bare-keyed summaryBodies.
   */
  droppedOccurrenceKeys?: string[];
  /**
   * Subset of droppedToolCallIds whose tool was user-protected. Membership is decided
   * per call by tool name (every call whose name ∈ protectedTools), not a per-id allowlist.
   * Their verbatim ToolResultMessage text is relocated into the synthetic
   * <compressed-chain> body at render time (pulled live from the raw branch) instead
   * of being dropped. Absent/empty ⇒ no protected outputs (identical to pre-feature render).
   */
  protectedToolCallIds?: string[];
  /**
   * Timestamp of the final text-only assistant in the chain.
   * Kept in context but with thinking blocks stripped.
   * Null when the chain was truncated (no text-only close found).
   */
  finalAssistantTimestamp: number | null;
  /** Short t<N> refs for the tool calls in this chain, surfaced in the synthetic message's `tools="..."` attribute. */
  toolRefs: string[];
  /** Epoch ms when the compression decision was recorded. */
  compressedAt: number;
  /**
   * Cohesive LLM range summary fusing the chain's per-batch summaries
   * (set when `chainCompression.fuseRangeSummary` is on and the span has >= 2
   * per-batch summaries to fuse). When present, the renderer uses this as the
   * synthetic `<compressed-chain>` body instead of the per-batch concatenation.
   * Absent on fusion failure / single-batch spans → renderer falls back to concat.
   */
  rangeSummaryText?: string;
  /**
   * "deterministic" = zero-LLM synthetic body built by the uncovered-chain
   * backfill path (rangeSummaryText holds the stub). Absent = LLM-fused or
   * per-batch semantics, unchanged.
   */
  bodySource?: "deterministic";
}

export interface SharedChainMember extends Omit<SingleChainCompressionEntry, "blockId" | "compressedAt" | "rangeSummaryText" | "bodySource"> {
  startEntryId: string;
  finalEntryId: string;
  sourceFingerprint: string;
  bodyStart: number;
  bodyEnd: number;
}

export interface SharedChainCompressionEntry {
  kind: "shared-v1";
  blockId: string;
  compressedAt: number;
  bodyText: string;
  members: SharedChainMember[];
}

export type ChainCompressionEntry = SingleChainCompressionEntry | SharedChainCompressionEntry;

export function isSharedChain(entry: ChainCompressionEntry): entry is SharedChainCompressionEntry {
  return "kind" in entry && entry.kind === "shared-v1";
}

/** Temporary render views; the durable shared body is stored only once. */
export function chainMembers(entry: ChainCompressionEntry): SingleChainCompressionEntry[] {
  return isSharedChain(entry) ? entry.members.map(member => ({ ...member,
    blockId: entry.blockId, compressedAt: entry.compressedAt,
    rangeSummaryText: entry.bodyText.slice(member.bodyStart, member.bodyEnd) })) : [entry];
}

export interface ChainCompressionConfig {
  enabled: boolean;
  /** Number of most-recently-closed chains to keep raw (not compressed). Default 3. */
  rollingWindow: number;
  /** Strip thinking blocks from the kept final text-only assistant. Default true. */
  stripFinalAssistantThinking: boolean;
  /**
   * Fuse a compressed chain's per-batch summaries into one cohesive LLM range
   * summary (one extra summarizer call per multi-batch span at compression
   * time). Off → the synthetic message keeps the per-batch concatenation.
   * Default true.
   */
  fuseRangeSummary: boolean;
}

export interface ErrorPurgeConfig {
  enabled: boolean;
  /** Wait this many turns after the error before purging the toolCall argument body. Default 2. */
  cooldownTurns: number;
  /** Only purge arg bodies larger than this many chars. Default 500. */
  minArgChars: number;
}

export const DEFAULT_CONFIG = decodePruneConfig(defaultMetisConfig().contextPrune) as ContextPruneConfig;

// ── Captured batch ─────────────────────────────────────────────────────────

/** A single tool call + its result as captured from turn_end */
export interface CapturedToolCall {
  /** Original assistant turn, retained across budget splitting and queue retries. */
  sourceTurn?: { turnIndex: number; timestamp: number };
	parentToolCallId?: string;
	nestedProtected?: boolean;
	nestedRootToolCallId?: string;
	/** Immutable mutation/status prefix; command body may live in an external archive. */
	resultPrefix?: string;
	fusionCommand?: { command: string; output: string };
  /** Undefined for running or legacy exec results; only a confirmed zero exit permits packing. */
  exitCode?: number;
  /** Provenance of an execution-layer archive, distinct from captured display text. */
  archiveSource?: "command-output" | "fused-command-output" | "fusion-journal";
  archiveComplete?: boolean;
  archiveAppendOnly?: boolean;
  outputArchive?: { path: string; bytes?: number; offsetBytes?: number; complete: boolean; appendOnly?: boolean; source?: "fused-command-output" | "fusion-journal" };
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  /**
   * Timestamp of the ToolResultMessage this call was paired with. The
   * occurrence discriminant (see src/occurrence-key.ts): provider ids repeat
   * within a session, this does not. Optional so pre-upgrade persisted
   * entries stay readable; absent => the record is legacy bare-id keyed.
   */
  resultTimestamp?: number;
  spillPath?: string;
  spillBytes?: number;
  resultPreview?: string;
  contentHash?: string;
}

/**
 * Captured assistant turn or budget-bounded group of tool calls.
 * turnIndex/timestamp identify the last source turn in the chunk.
 */
export interface CapturedBatch {
  turnIndex: number;
  timestamp: number;
  /** Any non-tool-call text from the assistant message (may be empty) */
  assistantText: string;
  toolCalls: CapturedToolCall[];
  /**
   * Grouping key assigned by `captureUnindexedBatchesFromSession`.
   * Increments for each user message seen while walking the branch.
   * Batches from the live `turn_end` path do NOT have this field set
   * (they are always emitted one-per-turn regardless of batchingMode).
   * Used by `groupBatchesByMode` to merge turns within the same
   * user → agent-message span when batchingMode === "agent-message".
   */
  userTurnGroup?: number;
}

// ── Index record ───────────────────────────────────────────────────────────

/**
 * A single tool call record stored in the runtime index.
 * Contains the full original tool output for context_tree_query recovery.
 */
export interface ToolCallRecord {
	parentToolCallId?: string;
	nestedProtected?: boolean;
	nestedRootToolCallId?: string;
  /** Durable recovery only; archiving alone must never change model-visible history. */
  archiveOnly?: boolean;
  /** Legacy dedup entry whose own execution metadata could not be recovered. */
  metadataUnavailable?: boolean;
	resultPrefix?: string;
  /** Provenance of an execution-layer archive, distinct from captured display text. */
  archiveSource?: "command-output" | "fused-command-output" | "fusion-journal";
  archiveComplete?: boolean;
  archiveAppendOnly?: boolean;

  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Full original result text. Empty ("") for spilled records — body lives in the sidecar file at spillPath. */
  resultText: string;
  isError: boolean;
  turnIndex: number;
  timestamp: number;
  /** See CapturedToolCall.resultTimestamp. */
  resultTimestamp?: number;
  /** Absolute path to the sidecar blob holding the full body (set only when the result was spilled). */
  spillPath?: string;
  /** Full byte length of the spilled body. */
  spillBytes?: number;
  /** Head preview kept inline when spilled (resultText is "" in that case). */
  resultPreview?: string;
  /** Dedup hash of the FULL body, persisted so reconstruct/addBatch skip rehashing the empty resultText. */
  contentHash?: string;
}

// ── Session persistence types ──────────────────────────────────────────────

/**
 * Data stored via pi.appendEntry(CUSTOM_TYPE_INDEX, data).
 * One entry per summarized batch; reconstructed into the runtime index on session_start.
 */
export interface IndexEntryData {
  toolCalls: ToolCallRecord[];
  /** Entry written by backfillChainRecords: records must NOT seed contentHashToOriginal. */
  backfilled?: true;
  /** Refs allocated at backfill time; durable carrier for alias reconstruction. */
  refs?: SummaryToolCallRef[];
}

/**
 * Data stored via pi.appendEntry(CUSTOM_TYPE_DEDUP_ALIAS, data).
 *
 * Each entry maps a duplicate toolCallId to the original (already-indexed)
 * toolCallId whose (toolName, exact resultText) hash it matched.
 *
 *  - pruneMessages stub-replaces the duplicate's ToolResultMessage using the
 *    original's short ref (via the indexer's toolCallIdToAlias map).
 *  - context_tree_query resolves the duplicate's id back to the original
 *    record via the indexer's dedup alias map.
 *
 * `hash` is optional and stored only for debugging; reconstruction works
 * without it because the original record is re-hashed when its
 * CUSTOM_TYPE_INDEX entry is replayed.
 */
export interface DedupAliasEntryData {
  newToolCallId: string;
  originalToolCallId: string;
  /** Occurrence timestamps for each side; absent on pre-upgrade entries. */
  newResultTimestamp?: number;
  originalResultTimestamp?: number;
  hash?: string;
}

/**
 * Short alias used in the summary message text plus the real toolCallId it
 * maps back to for future recovery through context_tree_query.
 */
export interface SummaryToolCallRef {
  shortId: string;
  toolCallId: string;
  /** ToolResultMessage timestamp; with toolCallId this forms the occurrence key. */
  resultTimestamp?: number;
}

/**
 * Details stored in the custom summary message's `details` field.
 * Machine-readable metadata so renderers and extensions can inspect summaries.
 */
export interface SummaryMessageDetails {
  toolCallRefs: SummaryToolCallRef[];
  toolNames: string[];
  turnIndex: number;
  timestamp: number;
}

/** Snapshot of what the pruner cannot (yet) reclaim. All token values are Math.round(JSON-chars / 4). */
export interface ContextMetricsSnapshot {
  /** Est. tokens of thinking blocks retained in the trailing open segment. */
  openCycleThinkingTokens: number;
  /** max(largest closed chain, open segment) chars / total branch chars, 0-100. */
  largestChainSharePct: number;
  /** Est. tokens of summarization-eligible unsummarized toolResults after the frontier. */
  frontierGapTokens: number;
}

export type FlushTrigger = "budget" | "delta" | "frontier-gap" | "message-end" | "context" | "manual" | "rearmed";

export type DeferredReason = "automatic-disabled" | "pressure" | "measurement" | "replacement" | "budget" | "no-gain";

export const DEFERRED_REASON_LABELS: Record<DeferredReason, string> = {
  "automatic-disabled": "automatic summarization disabled",
  pressure: "automatic summaries not admitted by pressure/capacity policy",
  measurement: "token measurement unavailable",
  replacement: "safe complete replacement unavailable",
  budget: "complete-summary token budget insufficient",
  "no-gain": "replacement would not reduce context tokens",
};

/** Payload of CUSTOM_TYPE_FLUSH_METRICS. */
export interface FlushMetricsEntry {
  ts: number;
  trigger: FlushTrigger;
  /** Batches after rescan+trim, before processing. */
  capturedBatches: number;
  processedBatches: number;
  /** Tool calls this flush newly made stub-eligible: dedup aliases on processed batches plus calls of batches actually indexed. 0 when nothing was indexed or aliased (all-trivial/oversized, or failure before any batch was processed). */
  stubCount: number;
  /** Net serialized projection reductions; not provider token/cost measurements. */
  publishedCharsSaved?: number;
  argumentCharsSaved?: number;
  firstChangedMessage?: number;
  outcome: "summarized" | "skipped-oversized" | "skipped-deduped" | "skipped-trivial" | "deferred" | "deferred-budget" | "empty" | "delivery-pending" | "partial" | "aborted" | "error";
  deferredReasons?: Partial<Record<DeferredReason, number>>;
  reason?: string;
  error?: string;
  /** Computed at flush ENTRY (pre-flush pressure). */
  metrics: ContextMetricsSnapshot;
}

// ── Summarizer stats ────────────────────────────────────────────────────────

/**
 * Cumulative token stats for summarizer LLM calls and chain compression.
 * Persisted via pi.appendEntry(CUSTOM_TYPE_STATS, ...) so stats survive
 * restarts and branch navigation.
 */
export interface SummarizerStats {
  /** Cumulative input tokens across all summarizer calls */
  totalInputTokens: number;
  /** Cumulative output tokens across all summarizer calls */
  totalOutputTokens: number;
  /** Number of completed summarizer calls with reported usage */
  callCount: number;
  /** Cumulative number of chains range-compressed across all flushes */
  chainsCompressed: number;
  /** Cumulative number of chains given a fused LLM range summary */
  rangesSummarized: number;
}

/** Transient before/after context-size measurement from the last prune (chars). */
export interface LiveReclaim {
  beforeChars: number;
  afterChars: number;
}

/** Outcome of the most recent completed prune attempt. */
export type PruneFrontierOutcome =
  | "summarized"
  | "skipped-oversized"
  | "skipped-trivial"
  | "skipped-deduped";

/**
 * Snapshot of the last successfully completed prune attempt boundary.
 *
 * This advances both when pruning succeeds and when a summary is rejected for
 * being larger than the raw tool-result text it would replace. Operational
 * failures do not advance the frontier.
 */
export interface PruneFrontier {
  /** Last tool call included in the completed prune attempt */
  lastAttemptedToolCallId: string;
  /** Occurrence identity when a tool ID is reused within a captured turn. */
  lastAttemptedResultTimestamp?: number;
  /** Name of the last tool call included in the completed prune attempt */
  lastAttemptedToolName: string;
  /** Assistant turn index containing the last attempted tool call */
  lastAttemptedTurnIndex: number;
  /** Timestamp captured when that last attempted tool call batch was recorded */
  lastAttemptedTimestamp: number;
  /** Number of batches included in the completed prune attempt */
  attemptedBatchCount: number;
  /** Number of tool calls included in the completed prune attempt */
  attemptedToolCallCount: number;
  /** Character count of the raw tool-result text that was eligible for pruning */
  rawCharCount: number;
  /** Character count of the rendered summary text that was produced */
  summaryCharCount: number;
  /** Whether the attempt actually pruned or was skipped for being oversized */
  outcome: PruneFrontierOutcome;
}

/**
 * Progress callback invoked by `flushPending` when processing batches sequentially.
 * Only fired when the caller passes `onProgress` in `FlushOptions` (i.e. `/pruner now`).
 */
export type ProgressCallback = (
  index: number,
  total: number,
  batch: CapturedBatch,
  stage: "start" | "done" | "skipped",
) => void;

/** Live text-progress callback for a batch currently being summarized. */
export type BatchTextProgressCallback = (
  index: number,
  total: number,
  batch: CapturedBatch,
  receivedChars: number,
) => void;

/** Options accepted by `flushPending`. */
export type FlushResult =
  | { ok: true; reason: "flushed" | "partial" | "skipped-oversized" | "skipped-trivial" | "skipped-deduped"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number; dedupedCount?: number; dedupedRawCharCount?: number; deferredReasons?: Partial<Record<DeferredReason, number>>; error?: string }
  | { ok: false; reason: "empty" | "already-flushing" | "deferred-occ" | "deferred" | "deferred-budget" | "input-budget" | "summarizer-failed" | "delivery-pending" | "stale-context" | "failed" | "aborted"; deferredReasons?: Partial<Record<DeferredReason, number>>; error?: string; batchCount?: number };

export interface FlushOptions {
  /** Delivery path: "runtime" uses sendMessage/steer (default); "session" writes directly to session. */
  delivery?: "runtime" | "session";
  /**
   * Invoked before/after each sequentially committed batch. Used by
   * `/pruner now` to drive the multi-row progress overlay.
   */
  onProgress?: ProgressCallback;
  /**
   * When provided, receives the number of summary characters streamed so far for
   * the currently-running batch. Used by `/pruner now` to show live progress.
   */
  onBatchTextProgress?: BatchTextProgressCallback;
  /**
   * Pre-captured batches from a prior `capturePendingBatches()` call.
   * When set, `flushPending` skips the internal capture step and uses these directly.
   * Avoids double-capture when the caller needs to know the batch count before
   * opening the progress overlay.
   */
  previewedBatches?: CapturedBatch[];
  /**
   * Abort signal — when fired the in-flight summarization is cancelled and
   * `flushPending` returns `{ ok: false, reason: "aborted" }`. Completed chunks
   * keep their durable frontier; unprocessed chunks are restored for retry.
   */
  signal?: AbortSignal;
  /** Which trigger initiated this flush. Defaults to "manual" when absent. */
  trigger?: FlushTrigger;
  /**
   * The final text-only assistant message that triggered an agent-message flush.
   * pi emits `message_end` to extensions before persisting it to the session, so it
   * is threaded in here to close the newest chain for compression (see
   * `withClosingMessage`). Only set on the message_end path.
   */
  closingMessage?: any;
}

/** Options for a single summarizeBatch() call. */
export interface SummarizeBatchOptions {
  /** Reports a discarded result's cause without putting it in model context. */
  onFailure?: (message: string, reason?: "input-budget" | "output-budget") => void;
  /** Complete rendered-message proxy budget; not a provider maxTokens value. */
  outputBudget?: { target: number; limit: number };
  /** Validate the complete decorated candidate. A rejection never retries a fallback. */
  acceptSummary?: (text: string) => Promise<boolean>;
  /** Provider usage, including responses rejected by the output-budget guard. */
  onUsage?: (usage: Usage) => void;
  /** Invoked only when a provider stream is about to be requested. */
  onModelAttempt?: () => void;
  /** Receives the number of summary text characters streamed so far. */
  onTextProgress?: (receivedChars: number) => void;
  /**
   * Abort signal — when fired the in-flight stream call is cancelled and the
   * batch is treated as aborted (not a summarizer failure).
   */
  signal?: AbortSignal;
  /**
   * Session-scoped outage-fallback controller. When present AND a distinct
   * fallback model exists, runSummarization routes/retries via the controller
   * (see src/summarizer-fallback.ts). Absent => today's single-attempt behavior.
   */
  controller?: FallbackController;
}

/**
 * Result of a summarization call — the summary text plus LLM usage data.
 */
export interface SummarizeResult {
  summaryText: string;
  /** Usage data from the LLM response (tokens + cost) */
  usage: Usage;
}
