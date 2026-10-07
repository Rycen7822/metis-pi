import { readFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig, PruneOn, SummarizerThinking } from "./types.ts";
import { DEFAULT_CONFIG, PRUNE_ON_MODES, SUMMARIZER_THINKING_LEVELS } from "./types.ts";
import { decodePruneConfig, encodePruneConfig, MetisConfigError, metisConfigPath, parseMetisConfig, readMetisConfig, updateMetisConfig } from "../metis-config.ts";

export const settingsPath = () => metisConfigPath(getAgentDir());
export const SETTINGS_KEY = "contextPrune" as const;
export { MetisConfigError as SettingsReadError };
function isPruneOn(value: unknown): value is PruneOn {
  return typeof value === "string" && PRUNE_ON_MODES.some(mode => mode.value === value);
}
function isSummarizerThinking(value: unknown): value is SummarizerThinking {
  return typeof value === "string" && SUMMARIZER_THINKING_LEVELS.some(level => level.value === value);
}
const booleanOrDefault = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const integerOrDefault = <T extends number | null>(value: unknown, fallback: T, minimum = 0, positive = false): number | T =>
  typeof value === "number" && Number.isFinite(value) && (positive ? value > minimum : value >= minimum) ? Math.floor(value) : fallback;
const fractionOrDefault = <T extends number | null>(value: unknown, fallback: T): number | T =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
function normalizeFallbackModels(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string")
    .map(entry => entry.trim()).filter(entry => /^[^/\s]+\/\S+$/.test(entry)))] : [];
}
const strings = (value: unknown, fallback: string[]) => Array.isArray(value) && value.every(item => typeof item === "string") ? value : [...fallback];
function normalize(existing: Partial<ContextPruneConfig>): ContextPruneConfig {
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...existing }, defaults = DEFAULT_CONFIG;
  const chain = existing.chainCompression, purge = existing.purgeErrors;
  const summaryBudget = { ...defaults.summaryBudget };
  for (const key of Object.keys(summaryBudget) as (keyof typeof summaryBudget)[]) {
    const value = existing.summaryBudget?.[key];
    if (key === "minGainFraction") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) summaryBudget[key] = value;
    } else if (Number.isSafeInteger(value) && value! >= (["maxBudgetWindowTokens", "minGainTokens", "maxProxyTokens"].includes(key) ? 1 : 0)) summaryBudget[key] = value!;
  }
  return {
    ...merged, summaryBudget,
    opportunisticCompaction: merged.opportunisticCompaction === true,
    enabled: booleanOrDefault(merged.enabled, defaults.enabled),
    showPruneStatusLine: booleanOrDefault(merged.showPruneStatusLine, defaults.showPruneStatusLine),
    showOccStatusLine: booleanOrDefault(merged.showOccStatusLine, defaults.showOccStatusLine),
    compactionSummaryMaxTokens: Number.isSafeInteger(merged.compactionSummaryMaxTokens) && merged.compactionSummaryMaxTokens >= 0 ? merged.compactionSummaryMaxTokens : defaults.compactionSummaryMaxTokens,
    summarizerModel: typeof merged.summarizerModel === "string" && merged.summarizerModel.trim() ? merged.summarizerModel : defaults.summarizerModel,
    pruneOn: isPruneOn(merged.pruneOn) ? merged.pruneOn : defaults.pruneOn,
    summarizerFallbackModels: normalizeFallbackModels(merged.summarizerFallbackModels),
    summarizerThinking: isSummarizerThinking(merged.summarizerThinking) ? merged.summarizerThinking : defaults.summarizerThinking,
    quietOversizedSkips: booleanOrDefault(merged.quietOversizedSkips, defaults.quietOversizedSkips),
    minBatchChars: integerOrDefault(merged.minBatchChars, defaults.minBatchChars),
    summarizerIdleTimeoutMs: integerOrDefault(merged.summarizerIdleTimeoutMs, defaults.summarizerIdleTimeoutMs),
    summarizerMaxTimeoutMs: integerOrDefault(merged.summarizerMaxTimeoutMs, defaults.summarizerMaxTimeoutMs),
    recoveryGraceTurns: integerOrDefault(merged.recoveryGraceTurns, defaults.recoveryGraceTurns),
    dedupByContentHash: booleanOrDefault(merged.dedupByContentHash, defaults.dedupByContentHash),
    autoBudgetThreshold: merged.autoBudgetThreshold === null ? null : fractionOrDefault(merged.autoBudgetThreshold, defaults.autoBudgetThreshold),
    spillThreshold: integerOrDefault(merged.spillThreshold, defaults.spillThreshold, 0, true),
    spillPreviewBytes: integerOrDefault(merged.spillPreviewBytes, defaults.spillPreviewBytes),
    budgetTurnDelta: fractionOrDefault(merged.budgetTurnDelta, defaults.budgetTurnDelta),
    frontierGapThresholdTokens: integerOrDefault(merged.frontierGapThresholdTokens, defaults.frontierGapThresholdTokens, 0, true),
    maxImagesPerRequest: integerOrDefault(merged.maxImagesPerRequest, defaults.maxImagesPerRequest, 1),
    protectedTools: strings(merged.protectedTools, defaults.protectedTools),
    protectedPaths: strings(merged.protectedPaths, defaults.protectedPaths),
    chainCompression: {
      enabled: booleanOrDefault(chain?.enabled, defaults.chainCompression.enabled),
      rollingWindow: integerOrDefault(chain?.rollingWindow, defaults.chainCompression.rollingWindow),
      stripFinalAssistantThinking: booleanOrDefault(chain?.stripFinalAssistantThinking, defaults.chainCompression.stripFinalAssistantThinking),
      fuseRangeSummary: booleanOrDefault(chain?.fuseRangeSummary, defaults.chainCompression.fuseRangeSummary),
    },
    purgeErrors: {
      enabled: booleanOrDefault(purge?.enabled, defaults.purgeErrors.enabled),
      cooldownTurns: integerOrDefault(purge?.cooldownTurns, defaults.purgeErrors.cooldownTurns),
      minArgChars: integerOrDefault(purge?.minArgChars, defaults.purgeErrors.minArgChars),
    },
  };
}
export async function loadConfig(): Promise<ContextPruneConfig> {
  try { return normalize(decodePruneConfig(readMetisConfig(getAgentDir()).config[SETTINGS_KEY] ?? {})); }
  catch (error) { if (error instanceof MetisConfigError) return structuredClone(DEFAULT_CONFIG); throw error; }
}
export async function saveConfig(config: ContextPruneConfig, read?: typeof readFile): Promise<void> {
  // Retain the injectable read boundary for failure fixtures; normal writers are synchronous and shared.
  if (read) {
    try { parseMetisConfig(await read(settingsPath(), "utf8"), settingsPath()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error instanceof MetisConfigError ? error : new MetisConfigError(settingsPath(), (error as NodeJS.ErrnoException).code ?? String(error));
    }
  }
  updateMetisConfig(getAgentDir(), { [SETTINGS_KEY]: encodePruneConfig(config) });
}
type Notify = (message: string, type?: "info" | "warning" | "error") => void;
export async function persistConfig(notify: Notify, config: ContextPruneConfig, save: (config: ContextPruneConfig) => Promise<void> = saveConfig): Promise<void> {
  try { await save(config); }
  catch (error) {
    const reason = error instanceof MetisConfigError ? error.reason : ((error as NodeJS.ErrnoException)?.code ?? String(error));
    notify(`Could not save settings to ${settingsPath()}: ${reason}. Change applies to this session only.`, "error");
  }
}
