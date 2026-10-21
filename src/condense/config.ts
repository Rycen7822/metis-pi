import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextPruneConfig, PruneOn } from "./types.ts";
import { BATCHING_MODE_VALUES, PRUNE_ON_VALUES, SUMMARIZER_THINKING_VALUES } from "./types.ts";
import {
  defaultMetisConfig,
  type MetisConfig,
  isMetisConfigTable,
  MetisConfigError,
  metisConfigPath,
  readMetisConfig,
  updateMetisConfig,
} from "../configuration/store.ts";

const nullable = ["autoBudgetThreshold", "budgetTurnDelta", "frontierGapThresholdTokens", "maxImagesPerRequest"];
export function encodePruneConfig(config: object): MetisConfig {
  const copy: MetisConfig = { ...config };
  for (const key of nullable) if (copy[key] === null) copy[key] = false;
  return copy;
}
export function decodePruneConfig(config: MetisConfig): MetisConfig {
  const copy = { ...config };
  for (const key of nullable) if (copy[key] === false) copy[key] = null;
  return copy;
}
const bundledDefaults = defaultMetisConfig().contextPrune;
// The bundled table is the domain's defaults; user tables still go through normalize.
export const DEFAULT_CONFIG = decodePruneConfig(isMetisConfigTable(bundledDefaults) ? bundledDefaults : {}) as unknown as ContextPruneConfig;

export const settingsPath = () => metisConfigPath(getAgentDir());
export const SETTINGS_KEY = "contextPrune" as const;
const booleanOrDefault = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
const integerOrDefault = <T extends number | null>(value: unknown, fallback: T, minimum = 0, positive = false): number | T =>
  typeof value === "number" && Number.isFinite(value) && (positive ? value > minimum : value >= minimum) ? Math.floor(value) : fallback;
const fractionOrDefault = <T extends number | null>(value: unknown, fallback: T): number | T =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;

// The scalar entry points share these domain fields. Labels, cycling presets and
// raw-string parsing belong to the settings UI; config locations and values do not.
type ScalarConfigValues = Pick<ContextPruneConfig,
  | "enabled" | "showPruneStatusLine" | "showOccStatusLine" | "compactionSummaryMaxTokens"
  | "pruneOn" | "summarizerThinking" | "batchingMode" | "quietOversizedSkips"
  | "minBatchChars" | "recoveryGraceTurns" | "summarizerIdleTimeoutMs" | "summarizerMaxTimeoutMs"
  | "autoBudgetThreshold" | "dedupByContentHash"
> & {
  "chainCompression.enabled": ContextPruneConfig["chainCompression"]["enabled"];
  "chainCompression.rollingWindow": ContextPruneConfig["chainCompression"]["rollingWindow"];
  "chainCompression.stripFinalAssistantThinking": ContextPruneConfig["chainCompression"]["stripFinalAssistantThinking"];
  "chainCompression.fuseRangeSummary": ContextPruneConfig["chainCompression"]["fuseRangeSummary"];
  "purgeErrors.enabled": ContextPruneConfig["purgeErrors"]["enabled"];
  "purgeErrors.cooldownTurns": ContextPruneConfig["purgeErrors"]["cooldownTurns"];
  "purgeErrors.minArgChars": ContextPruneConfig["purgeErrors"]["minArgChars"];
};
type ScalarConfigInputs = Omit<ScalarConfigValues, "pruneOn"> & { pruneOn: string };
export type ScalarConfigKey = keyof ScalarConfigValues;
export type ScalarConfigValue = ScalarConfigInputs[ScalarConfigKey];
export type ScalarConfigKind = "boolean" | "enum" | "integer" | "fraction";
interface ScalarRules<Value> {
  kind: ScalarConfigKind;
  accepts(value: unknown): value is Value;
  load(value: unknown, fallback: Value): Value;
}
interface ScalarAccessor<Value> extends ScalarRules<Value> {
  read(config: ContextPruneConfig): Value;
  write(config: ContextPruneConfig, value: Value): ContextPruneConfig;
}
function scalar<Value>(
  read: ScalarAccessor<Value>["read"], write: ScalarAccessor<Value>["write"], rules: ScalarRules<Value>,
): ScalarAccessor<Value> {
  return { read, write, ...rules };
}
const booleanRules: ScalarRules<boolean> = {
  kind: "boolean", accepts: (value): value is boolean => typeof value === "boolean", load: booleanOrDefault,
};
const integerRules: ScalarRules<number> = {
  kind: "integer",
  accepts: (value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0,
  load: integerOrDefault,
};
const summaryLimitRules: ScalarRules<number> = {
  ...integerRules,
  load: (value, fallback) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback,
};
const fractionRules: ScalarRules<number | null> = {
  kind: "fraction",
  accepts: (value): value is number | null => value === null ||
    (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1),
  load: (value, fallback) => value === null ? null : fractionOrDefault(value, fallback),
};
function enumRules<Value extends string>(values: readonly Value[]): ScalarRules<Value> {
  const accepts = (value: unknown): value is Value => typeof value === "string" && values.some(item => item === value);
  return { kind: "enum", accepts, load: (value, fallback) => accepts(value) ? value : fallback };
}
const SCALAR_FIELDS: { [Key in ScalarConfigKey]: ScalarAccessor<ScalarConfigValues[Key]> } = {
  enabled: scalar(c => c.enabled, (c, value) => ({ ...c, enabled: value }), booleanRules),
  showPruneStatusLine: scalar(c => c.showPruneStatusLine, (c, value) => ({ ...c, showPruneStatusLine: value }), booleanRules),
  showOccStatusLine: scalar(c => c.showOccStatusLine, (c, value) => ({ ...c, showOccStatusLine: value }), booleanRules),
  compactionSummaryMaxTokens: scalar(c => c.compactionSummaryMaxTokens,
    (c, value) => ({ ...c, compactionSummaryMaxTokens: value }), summaryLimitRules),
  pruneOn: scalar(c => c.pruneOn, (c, value) => ({ ...c, pruneOn: value }), enumRules(PRUNE_ON_VALUES)),
  summarizerThinking: scalar(c => c.summarizerThinking, (c, value) => ({ ...c, summarizerThinking: value }), enumRules(SUMMARIZER_THINKING_VALUES)),
  batchingMode: scalar(c => c.batchingMode, (c, value) => ({ ...c, batchingMode: value }), enumRules(BATCHING_MODE_VALUES)),
  quietOversizedSkips: scalar(c => c.quietOversizedSkips, (c, value) => ({ ...c, quietOversizedSkips: value }), booleanRules),
  minBatchChars: scalar(c => c.minBatchChars, (c, value) => ({ ...c, minBatchChars: value }), integerRules),
  recoveryGraceTurns: scalar(c => c.recoveryGraceTurns, (c, value) => ({ ...c, recoveryGraceTurns: value }), integerRules),
  summarizerIdleTimeoutMs: scalar(c => c.summarizerIdleTimeoutMs, (c, value) => ({ ...c, summarizerIdleTimeoutMs: value }), integerRules),
  summarizerMaxTimeoutMs: scalar(c => c.summarizerMaxTimeoutMs, (c, value) => ({ ...c, summarizerMaxTimeoutMs: value }), integerRules),
  autoBudgetThreshold: scalar(c => c.autoBudgetThreshold, (c, value) => ({ ...c, autoBudgetThreshold: value }), fractionRules),
  dedupByContentHash: scalar(c => c.dedupByContentHash, (c, value) => ({ ...c, dedupByContentHash: value }), booleanRules),
  "chainCompression.enabled": scalar(c => c.chainCompression.enabled,
    (c, value) => ({ ...c, chainCompression: { ...c.chainCompression, enabled: value } }), booleanRules),
  "chainCompression.rollingWindow": scalar(c => c.chainCompression.rollingWindow,
    (c, value) => ({ ...c, chainCompression: { ...c.chainCompression, rollingWindow: value } }), integerRules),
  "chainCompression.stripFinalAssistantThinking": scalar(c => c.chainCompression.stripFinalAssistantThinking,
    (c, value) => ({ ...c, chainCompression: { ...c.chainCompression, stripFinalAssistantThinking: value } }), booleanRules),
  "chainCompression.fuseRangeSummary": scalar(c => c.chainCompression.fuseRangeSummary,
    (c, value) => ({ ...c, chainCompression: { ...c.chainCompression, fuseRangeSummary: value } }), booleanRules),
  "purgeErrors.enabled": scalar(c => c.purgeErrors.enabled,
    (c, value) => ({ ...c, purgeErrors: { ...c.purgeErrors, enabled: value } }), booleanRules),
  "purgeErrors.cooldownTurns": scalar(c => c.purgeErrors.cooldownTurns,
    (c, value) => ({ ...c, purgeErrors: { ...c.purgeErrors, cooldownTurns: value } }), integerRules),
  "purgeErrors.minArgChars": scalar(c => c.purgeErrors.minArgChars,
    (c, value) => ({ ...c, purgeErrors: { ...c.purgeErrors, minArgChars: value } }), integerRules),
};
export function scalarConfigKind(key: ScalarConfigKey): ScalarConfigKind {
  return SCALAR_FIELDS[key].kind;
}
export function isScalarConfigValue<Key extends ScalarConfigKey>(key: Key, value: unknown): value is ScalarConfigValues[Key] {
  return SCALAR_FIELDS[key].accepts(value);
}
export function readScalarConfig<Key extends ScalarConfigKey>(config: ContextPruneConfig, key: Key): ScalarConfigValues[Key] {
  return SCALAR_FIELDS[key].read(config);
}
export function applyScalarConfig<Key extends ScalarConfigKey>(
  config: ContextPruneConfig, key: Key, value: ScalarConfigInputs[NoInfer<Key>],
): ContextPruneConfig {
  if (key === "pruneOn" && typeof value === "string") {
    // Commands historically retain any trigger string in-session. Keep that
    // narrow compatibility boundary; file loading still requires a known trigger.
    return { ...config, pruneOn: value as PruneOn };
  }
  const field = SCALAR_FIELDS[key];
  if (!field.accepts(value)) throw new Error(`invalid scalar setting value for ${key}`);
  return field.write(config, value);
}
function loadScalar<Key extends ScalarConfigKey>(key: Key, value: unknown): ScalarConfigValues[Key] {
  const field = SCALAR_FIELDS[key];
  return field.load(value, field.read(DEFAULT_CONFIG));
}
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
    } else if (
      Number.isSafeInteger(value) &&
      value! >= (["maxBudgetWindowTokens", "minGainTokens", "maxProxyTokens"].includes(key) ? 1 : 0)
    )
      summaryBudget[key] = value!;
  }
  return {
    ...merged,
    summaryBudget,
    opportunisticCompaction: merged.opportunisticCompaction === true,
    enabled: loadScalar("enabled", merged.enabled),
    showPruneStatusLine: loadScalar("showPruneStatusLine", merged.showPruneStatusLine),
    showOccStatusLine: loadScalar("showOccStatusLine", merged.showOccStatusLine),
    compactionSummaryMaxTokens: loadScalar("compactionSummaryMaxTokens", merged.compactionSummaryMaxTokens),
    summarizerModel:
      typeof merged.summarizerModel === "string" && merged.summarizerModel.trim()
        ? merged.summarizerModel
        : defaults.summarizerModel,
    pruneOn: loadScalar("pruneOn", merged.pruneOn),
    summarizerFallbackModels: normalizeFallbackModels(merged.summarizerFallbackModels),
    summarizerThinking: loadScalar("summarizerThinking", merged.summarizerThinking),
    quietOversizedSkips: loadScalar("quietOversizedSkips", merged.quietOversizedSkips),
    minBatchChars: loadScalar("minBatchChars", merged.minBatchChars),
    summarizerIdleTimeoutMs: loadScalar("summarizerIdleTimeoutMs", merged.summarizerIdleTimeoutMs),
    summarizerMaxTimeoutMs: loadScalar("summarizerMaxTimeoutMs", merged.summarizerMaxTimeoutMs),
    recoveryGraceTurns: loadScalar("recoveryGraceTurns", merged.recoveryGraceTurns),
    dedupByContentHash: loadScalar("dedupByContentHash", merged.dedupByContentHash),
    autoBudgetThreshold: loadScalar("autoBudgetThreshold", merged.autoBudgetThreshold),
    spillThreshold: integerOrDefault(merged.spillThreshold, defaults.spillThreshold, 0, true),
    spillPreviewBytes: integerOrDefault(merged.spillPreviewBytes, defaults.spillPreviewBytes),
    budgetTurnDelta: fractionOrDefault(merged.budgetTurnDelta, defaults.budgetTurnDelta),
    frontierGapThresholdTokens: integerOrDefault(merged.frontierGapThresholdTokens, defaults.frontierGapThresholdTokens, 0, true),
    maxImagesPerRequest: integerOrDefault(merged.maxImagesPerRequest, defaults.maxImagesPerRequest, 1),
    protectedTools: strings(merged.protectedTools, defaults.protectedTools),
    protectedPaths: strings(merged.protectedPaths, defaults.protectedPaths),
    chainCompression: {
      enabled: loadScalar("chainCompression.enabled", chain?.enabled),
      rollingWindow: loadScalar("chainCompression.rollingWindow", chain?.rollingWindow),
      stripFinalAssistantThinking: loadScalar("chainCompression.stripFinalAssistantThinking", chain?.stripFinalAssistantThinking),
      fuseRangeSummary: loadScalar("chainCompression.fuseRangeSummary", chain?.fuseRangeSummary),
    },
    purgeErrors: {
      enabled: loadScalar("purgeErrors.enabled", purge?.enabled),
      cooldownTurns: loadScalar("purgeErrors.cooldownTurns", purge?.cooldownTurns),
      minArgChars: loadScalar("purgeErrors.minArgChars", purge?.minArgChars),
    },
  };
}
export async function loadConfig(): Promise<ContextPruneConfig> {
  try {
    const raw = readMetisConfig(getAgentDir()).config[SETTINGS_KEY];
    return normalize(decodePruneConfig(isMetisConfigTable(raw) ? raw : {}));
  } catch (error) {
    if (error instanceof MetisConfigError) return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}
export async function saveConfig(config: ContextPruneConfig): Promise<void> {
  updateMetisConfig(getAgentDir(), { [SETTINGS_KEY]: encodePruneConfig(config) });
}
type Notify = (message: string, type?: "info" | "warning" | "error") => void;
export async function persistConfig(
  notify: Notify,
  config: ContextPruneConfig,
  save: (config: ContextPruneConfig) => Promise<void> = saveConfig,
): Promise<void> {
  try {
    await save(config);
  } catch (error) {
    const reason =
      error instanceof MetisConfigError ? error.reason : ((error as NodeJS.ErrnoException)?.code ?? String(error));
    notify(`Could not save settings to ${settingsPath()}: ${reason}. Change applies to this session only.`, "error");
  }
}
