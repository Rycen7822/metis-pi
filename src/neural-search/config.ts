import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isMetisConfigTable, metisConfigPath, readMetisConfig } from "../metis-config.ts";
import { HOME_DIR } from "./native/paths.ts";

const BOOLEAN_KEYS = ["enabled", "mentions", "enableFsRootScanning", "enableHomeDirScanning", "warnOnHomeDirScan", "followSymlinks"] as const;
const DATABASES = { frecencyDbPath: "frecency", historyDbPath: "history" } as const;
const KEYS = new Set<string>([...BOOLEAN_KEYS, ...Object.keys(DATABASES)]);
export type NeuralSearchConfig = Record<typeof BOOLEAN_KEYS[number], boolean> & Record<keyof typeof DATABASES, string>;

/** Root TOML owns defaults; this boundary validates and resolves effective paths once. */
export function loadConfig(agentDir = getAgentDir()): NeuralSearchConfig {
  const value = readMetisConfig(agentDir).config.neuralSearch;
  const label = `${metisConfigPath(agentDir)} [neuralSearch]`;
  if (!isMetisConfigTable(value)) throw new Error(`${label} must be a table.`);
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) throw new Error(`${label}: unknown option "${key}".`);
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] !== "boolean") throw new Error(`${label}.${key} must be a boolean.`);
  }
  // All boolean fields were validated above; database fields are filled below.
  const config = { ...value, frecencyDbPath: "", historyDbPath: "" } as NeuralSearchConfig;
  for (const key of Object.keys(DATABASES) as (keyof typeof DATABASES)[]) {
    const raw = value[key] ?? path.join("metis", "neural-search", DATABASES[key]);
    if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
      throw new Error(`${label}.${key} must be a non-empty path string without NUL characters.`);
    }
    try { config[key] = resolveDbPath(raw, agentDir); }
    catch (error) { throw new Error(`${label}.${key}: ${(error as Error).message}`, { cause: error }); }
  }
  return config;
}

function resolveDbPath(value: string, agentDir: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return HOME_DIR;
  if (trimmed.startsWith("~/")) return path.resolve(HOME_DIR, trimmed.slice(2));
  if (trimmed.startsWith("~")) throw new Error("Use ~/ for home-relative paths; ~user expansion is not supported.");
  return path.resolve(agentDir, trimmed);
}
