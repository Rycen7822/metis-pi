// Scalar settings fields shared by the SettingsList overlay (settings.ts) and
// the /pruner command verbs (commands.ts). Each row is one config location
// with its option cycle, parse kind and description text; the helpers below
// are the single implementation of display, legality and write. The two entry
// points keep their own illegal-value policy — the overlay stores
// `fallbackValue(row)`, a command reports an error and saves nothing — so
// `parseScalar` only answers legality. Complex shapes (model picker, protected
// lists) keep their dedicated code in settings.ts.

import type { ContextPruneConfig } from "./types.js";
import {
  PRUNE_ON_MODES, BATCHING_MODES, SUMMARIZER_THINKING_LEVELS,
  MIN_BATCH_CHARS_PRESETS, RECOVERY_GRACE_PRESETS,
  SUMMARIZER_IDLE_TIMEOUT_PRESETS, SUMMARIZER_MAX_TIMEOUT_PRESETS,
  AUTO_BUDGET_PRESETS, ROLLING_WINDOW_PRESETS,
  PURGE_COOLDOWN_PRESETS, PURGE_MIN_ARG_PRESETS, DEFAULT_CONFIG,
} from "./types.js";
import { MAX_BUDGET_WINDOW } from "./budget.js";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

/** A parsed or written field value. `null` is only the auto-budget "off" state. */
export type ScalarValue = boolean | number | string | null;

export type ScalarKind = "boolean" | "enum" | "integer" | "fraction";

export interface ScalarRow {
  /** SettingsList item id. */
  readonly id: string;
  /** Config location: a top-level key or "group.key". */
  readonly path: string;
  readonly label: string;
  readonly options: readonly FieldOption[];
  /**
   * `boolean` accepts "true"/"false"; `enum` its own option values (any raw
   * string while `loose`); `integer`/`fraction` a number at or above `min`
   * (default 0) / in (0, 1]. Integer and fraction rows show an out-of-cycle
   * persisted value as the matching default preset.
   */
  readonly kind: ScalarKind;
  readonly description: string | ((config: ContextPruneConfig) => string);
  readonly min?: number;
  readonly loose?: boolean;
}

const PRUNE_MODE_GUIDANCE: Record<ContextPruneConfig["pruneOn"], string> = {
  "agent-message": "Recommended default. Batches tool work and prunes once after the final text reply, giving the best balance of automation, context savings, and cache stability.",
  "on-demand": "Maximum manual control. Nothing is pruned until you run /pruner now, so cache invalidation happens only when you choose.",
};

function pruneTriggerDescription(config: ContextPruneConfig): string {
  const mode = config.pruneOn;
  const guidance = PRUNE_MODE_GUIDANCE[mode] ?? "Controls when summarized tool outputs replace raw tool results in future context.";
  return `When to summarize tool outputs. Current mode: ${optionLabel("pruneOn", mode)} (${mode}) — ${guidance} Press Enter/Space to cycle through modes.`;
}

function summarizerThinkingDescription(config: ContextPruneConfig): string {
  const level = config.summarizerThinking;
  if (level === "default") {
    return "Preserve old behavior: send no explicit thinking option for summarizer calls.";
  }
  if (level === "off") {
    return "Request no summarizer reasoning where the provider adapter supports it; some providers may fall back to their default.";
  }
  return `Request ${level} thinking/reasoning for summarizer calls where supported.`;
}

function batchingModeDescription(config: ContextPruneConfig): string {
  if (config.batchingMode === "turn") {
    return "Per turn (default): one summary per assistant turn. Keeps summaries small and granular.";
  }
  return "Per agent message: merges all assistant turns between two user messages into one summary. Fewer, larger summaries per conversation exchange.";
}

function pruneStatusLineDescription(config: ContextPruneConfig): string {
  const base = config.showPruneStatusLine ? "ON" : "OFF";
  if (config.showPruneStatusLine) {
    return `Show the prune footer status line and queued turn notifications. Currently ${base}.`;
  }
  return `Hide the prune footer status line and queued turn notifications. Currently ${base}.`;
}

function quietOversizedSkipsDescription(config: ContextPruneConfig): string {
  const base = config.quietOversizedSkips ? "ON" : "OFF";
  if (config.quietOversizedSkips) {
    return `Suppress all non-error 'skipped pruning' notifications — both 'oversized' (summary was larger than the raw output) and 'trivial' (batch was below minBatchChars, no LLM call made). The frontier still advances in both cases. Currently ${base}.`;
  }
  return `Show 'skipped pruning' info notifications when a batch is skipped — either because the summary would have been larger than the raw output (oversized) or because the batch was below minBatchChars (trivial, no LLM call). Currently ${base}.`;
}

function minBatchCharsDescription(config: ContextPruneConfig): string {
  if (config.minBatchChars === 0) {
    return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently 0 — disabled, every batch is sent to the summarizer.`;
  }
  return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently ${config.minBatchChars}. Useful for sessions with many tiny tool calls. Set to 0 to disable.`;
}

function recoveryGraceDescription(config: ContextPruneConfig): string {
  if (config.recoveryGraceTurns === 0) {
    return "context_tree_query output is stubbed immediately (grace disabled). Set to a positive integer to keep recovered output verbatim for that many user-turn-groups.";
  }
  return `context_tree_query (recovery) output stays verbatim for ${config.recoveryGraceTurns} user-turn-group(s) after recovery, then reverts to the stub. Bounds the recover->re-stub->re-query loop. Currently ${config.recoveryGraceTurns}. Set to 0 to disable.`;
}

function idleTimeoutDescription(config: ContextPruneConfig): string {
  if (config.summarizerIdleTimeoutMs === 0) {
    return "Summarizer idle timeout DISABLED - a stalled stream is only bounded by the ceiling (or not at all if that is 0 too).";
  }
  return `Abort a summarizer call after ${Math.round(config.summarizerIdleTimeoutMs / 1000)}s of silence (no stream event). Resets on every event, so it never aborts a flowing generation; a timeout feeds the same outage-fallback retry as a provider error. Set 0 to disable.`;
}

function maxTimeoutDescription(config: ContextPruneConfig): string {
  if (config.summarizerMaxTimeoutMs === 0) {
    return "Summarizer total-duration ceiling DISABLED - only the idle timeout bounds a call.";
  }
  return `Hard ceiling on total duration of a single summarizer call: ${Math.round(config.summarizerMaxTimeoutMs / 1000)}s. Backstop for a stream that dribbles forever without going idle. Set 0 to disable.`;
}

function autoBudgetThresholdDescription(config: ContextPruneConfig): string {
  const cap = `${MAX_BUDGET_WINDOW / 1000}k`;
  if (config.autoBudgetThreshold == null) {
    return `Token-budget auto-flush: force a prune when context usage reaches this share of the window (or ${cap} tokens, whichever comes first), regardless of prune-on mode. Currently off. Pick a percentage to enable.`;
  }
  const pct = Math.round(config.autoBudgetThreshold * 100);
  return `Token-budget auto-flush: force a prune when context usage reaches ${pct}% of the window or ${cap} tokens, whichever comes first, regardless of prune-on mode. The ${cap} ceiling keeps this reachable on huge-window models. Set to Off to disable.`;
}

function dedupByContentHashDescription(config: ContextPruneConfig): string {
  if (config.dedupByContentHash) {
    return `Pre-flush content-hash dedup. When a captured tool call's (toolName, normalized resultText) matches a record already in the indexer, the duplicate is registered as an alias of the original — no summarizer LLM call. Currently ON.`;
  }
  return `Pre-flush content-hash dedup. Currently OFF. Identical re-reads will be sent to the summarizer like any other tool call.`;
}

function chainCompressionEnabledDescription(config: ContextPruneConfig): string {
  return `Range-compress closed chains beyond the rolling window (K=${config.chainCompression.rollingWindow}). Drops middle assistant turns + tool results, injects a synthetic summary. Currently ${config.chainCompression.enabled ? "ON" : "OFF"}.`;
}

function chainWindowDescription(config: ContextPruneConfig): string {
  return `Keep the K most-recently-closed chains raw; compress older ones. Currently ${config.chainCompression.rollingWindow}.`;
}

function stripThinkingDescription(config: ContextPruneConfig): string {
  return `Strip thinking blocks from the kept final text-only assistant message when compressing a chain. Currently ${config.chainCompression.stripFinalAssistantThinking ? "ON" : "OFF"}.`;
}

function fuseRangeDescription(config: ContextPruneConfig): string {
  return `Fuse a compressed chain's per-batch summaries into one cohesive LLM summary (one extra summarizer call per multi-batch span). Off keeps the per-batch concatenation. Currently ${config.chainCompression.fuseRangeSummary ? "ON" : "OFF"}.`;
}

function purgeErrorsEnabledDescription(config: ContextPruneConfig): string {
  return `Replace failed toolCall argument bodies with compact stubs after a cooldown. Reclaims context from large write/edit args that will never succeed. Currently ${config.purgeErrors.enabled ? "ON" : "OFF"}.`;
}

function purgeCooldownDescription(config: ContextPruneConfig): string {
  return `Wait this many turns after a tool error before purging its argument body. Currently ${config.purgeErrors.cooldownTurns}.`;
}

function purgeMinArgCharsDescription(config: ContextPruneConfig): string {
  return `Only purge arg bodies at least this many chars. Currently ${config.purgeErrors.minArgChars}.`;
}

const BOOLEAN_OPTIONS: readonly FieldOption[] = [
  { value: "true", label: "true" },
  { value: "false", label: "false" },
];

export const SCALAR_ROWS: readonly ScalarRow[] = [
  { id: "enabled", path: "enabled", label: "Enabled", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: "Enable or disable context pruning" },
  { id: "showPruneStatusLine", path: "showPruneStatusLine", label: "Prune status line", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: pruneStatusLineDescription },
  { id: "showOccStatusLine", path: "showOccStatusLine", label: "OCC status line", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: "Show OCC progress and retain its latest result in the footer. Does not affect compaction." },
  { id: "pruneOn", path: "pruneOn", label: "Prune trigger", kind: "enum", loose: true,
    options: PRUNE_ON_MODES, description: pruneTriggerDescription },
  { id: "summarizerThinking", path: "summarizerThinking", label: "Summarizer thinking", kind: "enum",
    options: SUMMARIZER_THINKING_LEVELS, description: summarizerThinkingDescription },
  { id: "batchingMode", path: "batchingMode", label: "Batching mode", kind: "enum",
    options: BATCHING_MODES, description: batchingModeDescription },
  { id: "quietOversizedSkips", path: "quietOversizedSkips", label: "Quiet skip notifications", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: quietOversizedSkipsDescription },
  { id: "minBatchChars", path: "minBatchChars", label: "Min batch chars", kind: "integer",
    options: MIN_BATCH_CHARS_PRESETS, description: minBatchCharsDescription },
  { id: "recoveryGraceTurns", path: "recoveryGraceTurns", label: "Recovery grace (user-turn-groups)", kind: "integer",
    options: RECOVERY_GRACE_PRESETS, description: recoveryGraceDescription },
  { id: "summarizerIdleTimeoutMs", path: "summarizerIdleTimeoutMs", label: "Summarizer idle timeout", kind: "integer",
    options: SUMMARIZER_IDLE_TIMEOUT_PRESETS, description: idleTimeoutDescription },
  { id: "summarizerMaxTimeoutMs", path: "summarizerMaxTimeoutMs", label: "Summarizer max timeout", kind: "integer",
    options: SUMMARIZER_MAX_TIMEOUT_PRESETS, description: maxTimeoutDescription },
  { id: "autoBudgetThreshold", path: "autoBudgetThreshold", label: "Auto-flush at context %", kind: "fraction",
    options: AUTO_BUDGET_PRESETS, description: autoBudgetThresholdDescription },
  { id: "dedupByContentHash", path: "dedupByContentHash", label: "Dedup by content hash", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: dedupByContentHashDescription },
  { id: "chainCompressionEnabled", path: "chainCompression.enabled", label: "Chain compression", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: chainCompressionEnabledDescription },
  { id: "chainCompressionRollingWindow", path: "chainCompression.rollingWindow", label: "Chain window (K)", kind: "integer", min: 1,
    options: ROLLING_WINDOW_PRESETS, description: chainWindowDescription },
  { id: "chainCompressionStripThinking", path: "chainCompression.stripFinalAssistantThinking", label: "Strip final thinking", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: stripThinkingDescription },
  { id: "chainCompressionFuseRange", path: "chainCompression.fuseRangeSummary", label: "Fuse range summary", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: fuseRangeDescription },
  { id: "purgeErrorsEnabled", path: "purgeErrors.enabled", label: "Error purge", kind: "boolean",
    options: BOOLEAN_OPTIONS, description: purgeErrorsEnabledDescription },
  { id: "purgeErrorsCooldown", path: "purgeErrors.cooldownTurns", label: "Error purge cooldown (turns)", kind: "integer", min: 1,
    options: PURGE_COOLDOWN_PRESETS, description: purgeCooldownDescription },
  { id: "purgeErrorsMinArgChars", path: "purgeErrors.minArgChars", label: "Error purge min arg chars", kind: "integer",
    options: PURGE_MIN_ARG_PRESETS, description: purgeMinArgCharsDescription },
];

export function scalarRow(id: string): ScalarRow {
  const row = SCALAR_ROWS.find((entry) => entry.id === id);
  if (!row) throw new Error(`unknown scalar setting field: ${id}`);
  return row;
}

/** Option values in display order (the SettingsList cycle / legal command values). */
export function optionValues(row: ScalarRow): string[] {
  return row.options.map((option) => option.value);
}

/** Display label of a field's current value (falls back to the raw value). */
export function optionLabel(id: string, value: string): string {
  return scalarRow(id).options.find((option) => option.value === value)?.label ?? value;
}

/** Raw option string → legal value, or undefined when the entry point must reject it. */
export function parseScalar(row: ScalarRow, raw: string): ScalarValue | undefined {
  if (row.kind === "boolean") return raw === "true" ? true : raw === "false" ? false : undefined;
  if (row.kind === "integer") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= (row.min ?? 0) ? parsed : undefined;
  }
  if (row.kind === "fraction") {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
  }
  return row.loose || row.options.some((option) => option.value === raw) ? raw : undefined;
}

/** Current value formatted for the SettingsList cycle. */
export function displayValue(row: ScalarRow, config: ContextPruneConfig): string {
  const value = pathValue(config, row.path);
  const raw = value == null ? "0" : String(value);
  if (row.kind !== "integer" && row.kind !== "fraction") return raw;
  return row.options.some((option) => option.value === raw)
    ? raw
    : defaultPreset(row.options, pathValue(DEFAULT_CONFIG, row.path));
}

/** Value the overlay stores when `parseScalar` rejects a raw string. */
export function fallbackValue(row: ScalarRow): ScalarValue {
  return row.kind === "boolean" ? false : pathValue(DEFAULT_CONFIG, row.path);
}

export function writeScalar(config: ContextPruneConfig, row: ScalarRow, value: ScalarValue): ContextPruneConfig {
  const dot = row.path.indexOf(".");
  if (dot === -1) return { ...config, [row.path]: value } as ContextPruneConfig;
  const group = row.path.slice(0, dot) as "chainCompression" | "purgeErrors";
  const key = row.path.slice(dot + 1);
  return { ...config, [group]: { ...config[group], [key]: value } } as ContextPruneConfig;
}

export function rowDescription(row: ScalarRow, config: ContextPruneConfig): string {
  return typeof row.description === "function" ? row.description(config) : row.description;
}

/** Resolve a "group.key" (or top-level key) path against a config object. */
function pathValue(config: ContextPruneConfig, path: string): ScalarValue {
  const dot = path.indexOf(".");
  if (dot === -1) return config[path as keyof ContextPruneConfig] as ScalarValue;
  const group = config[path.slice(0, dot) as "chainCompression" | "purgeErrors"] as unknown as Record<string, ScalarValue>;
  return group[path.slice(dot + 1)]!;
}

/** Preset whose value equals `value`, else the first preset. */
function defaultPreset(options: readonly FieldOption[], value: ScalarValue): string {
  return options.find((option) => option.value === String(value))?.value ?? options[0]!.value;
}
