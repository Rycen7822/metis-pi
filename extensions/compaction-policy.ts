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
  const section = readMetisConfig(getAgentDir()).config.compactionPolicy;
  if (!isMetisConfigTable(section)) throw new Error("compactionPolicy must be a TOML table");
  const contextWindowAbove = positiveTokens(section, "contextWindowAbove");
  const autoCompactTokenLimit = positiveTokens(section, "autoCompactTokenLimit");
  if (!pi.registerCompactionLimit) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("Metis compaction policy requires the managed Pi SDK; using Pi settings.", "warning");
    });
    return;
  }
  pi.registerCompactionLimit({ contextWindowAbove, autoCompactTokenLimit });
}
