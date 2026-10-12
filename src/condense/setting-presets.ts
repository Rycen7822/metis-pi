import type { BatchingMode, PruneOn, SummarizerThinking } from "./types.ts";

/** Labels and cycling choices for the settings UI. Legal policy values live in types.ts. */
export const SUMMARIZER_THINKING_LEVELS: { value: SummarizerThinking; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
];

export const PURGE_COOLDOWN_PRESETS: { value: string; label: string }[] = [
  { value: "1", label: "1" },
  { value: "2", label: "2 (default)" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
];

export const PURGE_MIN_ARG_PRESETS: { value: string; label: string }[] = [
  { value: "100", label: "100" },
  { value: "500", label: "500 (default)" },
  { value: "1000", label: "1000" },
  { value: "5000", label: "5000" },
];

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

export const PRUNE_ON_MODES: { value: PruneOn; label: string }[] = [
  { value: "agent-message", label: "On agent message" },
  { value: "on-demand", label: "On demand" },
];
