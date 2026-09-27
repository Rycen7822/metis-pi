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
 *   - User config: .pi/settings.json → "contextPrune" key (JSON merge safe,
 *     Pi preserves unknown keys when rewriting settings files)
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
/** The registered name of the recovery tool (src/query-tool.ts). Shared so the
 * grace checks in pruner.ts / chain-compressor.ts cannot drift from registration. */
export const QUERY_TOOL_NAME = "context_tree_query";
/** pi.events channel for cross-extension cost contributions (an aggregator like pi-subagents folds these into one total). */
export const EXTERNAL_COST_CHANNEL = "cost:external";
/** Stable producer id for this extension's cost contributions. */
export const EXTERNAL_COST_SOURCE = "pi-condense";
/** Footer status widget ID */
export const STATUS_WIDGET_ID = "context-prune";
/**
 * Widget ID for the live /pruner now progress panel shown above the editor.
 */
export const PROGRESS_WIDGET_ID = "context-prune-progress";
/** Choices for the summarizer thinking setting (used by commands and settings overlay) */
export const SUMMARIZER_THINKING_LEVELS = [
    { value: "default", label: "Default" },
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "XHigh" },
];
/** Cycling presets for the `purgeErrors.cooldownTurns` setting. */
export const PURGE_COOLDOWN_PRESETS = [
    { value: "1", label: "1" },
    { value: "2", label: "2 (default)" },
    { value: "3", label: "3" },
    { value: "5", label: "5" },
    { value: "10", label: "10" },
];
/** Cycling presets for the `purgeErrors.minArgChars` setting. */
export const PURGE_MIN_ARG_PRESETS = [
    { value: "100", label: "100" },
    { value: "500", label: "500 (default)" },
    { value: "1000", label: "1000" },
    { value: "5000", label: "5000" },
];
/** Choices for the batching-mode setting (used by commands and settings overlay) */
export const BATCHING_MODES = [
    { value: "turn", label: "Per turn" },
    { value: "agent-message", label: "Per agent message" },
];
/**
 * Cycling preset values for the `chainCompression.rollingWindow` setting.
 * Stored as strings because SettingsList cycles string values; converted to
 * number when applied.
 */
export const ROLLING_WINDOW_PRESETS = [
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
export const MIN_BATCH_CHARS_PRESETS = [
    { value: "0", label: "0 (disabled)" },
    { value: "500", label: "500" },
    { value: "1000", label: "1000 (default)" },
    { value: "2000", label: "2000" },
    { value: "5000", label: "5000" },
];
/**
 * Cycling presets for the `recoveryGraceTurns` setting in the SettingsList.
 * Stored as strings; converted to number when applied. "0" disables the grace
 * (recovery output stubs immediately, pre-feature behavior).
 */
export const RECOVERY_GRACE_PRESETS = [
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
export const SUMMARIZER_IDLE_TIMEOUT_PRESETS = [
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
export const SUMMARIZER_MAX_TIMEOUT_PRESETS = [
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
export const AUTO_BUDGET_PRESETS = [
    { value: "0", label: "Off (default)" },
    { value: "0.6", label: "60%" },
    { value: "0.7", label: "70%" },
    { value: "0.8", label: "80%" },
    { value: "0.9", label: "90%" },
];
/** Choices for the prune-on setting (used by commands and settings overlay) */
export const PRUNE_ON_MODES = [
    { value: "agent-message", label: "On agent message" },
    { value: "on-demand", label: "On demand" },
];
export const DEFAULT_CONFIG = {
    opportunisticCompaction: false,
    enabled: false,
    showPruneStatusLine: true,
    summarizerModel: "default",
    summarizerThinking: "default",
    pruneOn: "agent-message",
    batchingMode: "turn",
    quietOversizedSkips: false,
    minBatchChars: 1000,
    recoveryGraceTurns: 3,
    summarizerIdleTimeoutMs: 20000,
    summarizerMaxTimeoutMs: 180000,
    protectedTools: [],
    protectedPaths: ["**/skills/**/*.md", "**/gauntlet-overrides.md"],
    chainCompression: {
        enabled: true,
        rollingWindow: 3,
        stripFinalAssistantThinking: true,
        fuseRangeSummary: true,
    },
    purgeErrors: {
        enabled: true,
        cooldownTurns: 2,
        minArgChars: 500,
    },
    dedupByContentHash: true,
    autoBudgetThreshold: null,
    spillThreshold: 65536,
    spillPreviewBytes: 2048,
    budgetTurnDelta: null,
    frontierGapThresholdTokens: null,
    maxImagesPerRequest: null,
};
