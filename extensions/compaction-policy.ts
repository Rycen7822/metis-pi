import { hasMetisHostSDK } from "../src/pi-sdk/host.ts";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isMetisConfigTable, readMetisConfig, type MetisConfig } from "../src/configuration/store.ts";

function positiveTokens(config: MetisConfig, key: string): number {
  const value = config[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`compactionPolicy.${key} must be a positive integer (tokens)`);
  }
  return value;
}

export default function compactionPolicy(pi: ExtensionAPI): void {
  if (!hasMetisHostSDK()) return;
  const section = readMetisConfig(getAgentDir()).config.compactionPolicy;
  if (!isMetisConfigTable(section)) throw new Error("compactionPolicy must be a TOML table");
  const contextWindowAbove = positiveTokens(section, "contextWindowAbove");
  const autoCompactTokenLimit = positiveTokens(section, "autoCompactTokenLimit");
  if (!pi.registerCompactionLimit) throw new Error("Metis SDK is missing the compaction limit API");
  pi.registerCompactionLimit({ contextWindowAbove, autoCompactTokenLimit });
}
