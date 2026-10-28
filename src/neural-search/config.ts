import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "smol-toml";
import { isMetisConfigTable, metisConfigPath, readMetisConfigSnapshot, type MetisConfigStamp } from "../configuration/store.ts";
import { HOME_DIR } from "./native/paths.ts";

const BOOLEAN_KEYS = ["enabled", "mentions", "enableFsRootScanning", "enableHomeDirScanning", "warnOnHomeDirScan", "followSymlinks"] as const;
const DATABASES = { frecencyDbPath: "frecency", historyDbPath: "history" } as const;
const KEYS = new Set<string>([...BOOLEAN_KEYS, ...Object.keys(DATABASES), "semantic"]);
export type CacheBudgetMiB = 256 | 512 | 1024;
export type NeuralSearchConfig = Record<typeof BOOLEAN_KEYS[number], boolean> & Record<keyof typeof DATABASES, string> & {
  semantic: { cacheBudgetMiB: CacheBudgetMiB };
};
export interface SemanticBudgetSelection {
  budget_mib: CacheBudgetMiB;
  source: string;
  stamp: MetisConfigStamp | null;
}

/** Root TOML owns defaults; this boundary validates and resolves effective paths once. */
export function loadConfig(agentDir = getAgentDir()): NeuralSearchConfig {
  return readNeuralSnapshot(agentDir).config;
}
/** Fresh per-request selection. Do not reuse a startup config across edits. */
export function loadSemanticBudgetSelection(agentDir = getAgentDir()): SemanticBudgetSelection {
  const { config, source } = readNeuralSnapshot(agentDir);
  return { budget_mib: config.semantic.cacheBudgetMiB, source: source.path, stamp: source.stamp };
}
function readNeuralSnapshot(agentDir: string) {
  const source = readMetisConfigSnapshot(agentDir);
  const value = source.config.neuralSearch;
  const label = `${metisConfigPath(agentDir)} [neuralSearch]`;
  if (!isMetisConfigTable(value)) throw new Error(`${label} must be a table.`);
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new Error(`${label}: unknown option "${key}".`);
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] !== "boolean") throw new Error(`${label}.${key} must be a boolean.`);
  }
  const semantic = value.semantic;
  if (!isMetisConfigTable(semantic)) throw new Error(`${label}.semantic must be a table.`);
  for (const key of Object.keys(semantic)) {
    if (key !== "cacheBudgetMiB") throw new Error(`${label}.semantic: unknown option "${key}".`);
  }
  const budget = semantic.cacheBudgetMiB;
  if (budget !== 256 && budget !== 512 && budget !== 1024) {
    throw new Error(`${label}.semantic.cacheBudgetMiB must be an integer: 256, 512 or 1024.`);
  }
  // JS Number loses the distinction between TOML 512 and 512.0. Reparse the
  // same immutable source text with bigint integers, never read another file.
  if (source.text !== undefined) {
    const literal = parse(source.text.replace(/^\uFEFF/, ""), { integersAsBigInt: true }).neuralSearch;
    if (isMetisConfigTable(literal) && isMetisConfigTable(literal.semantic)
      && literal.semantic.cacheBudgetMiB !== undefined && typeof literal.semantic.cacheBudgetMiB !== "bigint") {
      throw new Error(`${label}.semantic.cacheBudgetMiB must be a TOML integer, not a float or string.`);
    }
  }
  // Boolean fields and semantic budget were validated; database fields follow.
  const config = { ...value, semantic: { cacheBudgetMiB: budget } } as NeuralSearchConfig;
  for (const key of Object.keys(DATABASES) as (keyof typeof DATABASES)[]) {
    const raw = value[key] ?? path.join("metis", "neural-search", DATABASES[key]);
    if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
      throw new Error(`${label}.${key} must be a non-empty path string without NUL characters.`);
    }
    try { config[key] = resolveDbPath(raw, agentDir); }
    catch (error) { throw new Error(`${label}.${key}: ${(error as Error).message}`, { cause: error }); }
  }
  return { config, source };
}

function resolveDbPath(value: string, agentDir: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return HOME_DIR;
  if (trimmed.startsWith("~/")) return path.resolve(HOME_DIR, trimmed.slice(2));
  if (trimmed.startsWith("~")) throw new Error("Use ~/ for home-relative paths; ~user expansion is not supported.");
  return path.resolve(agentDir, trimmed);
}
