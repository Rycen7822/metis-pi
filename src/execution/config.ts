import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultMetisConfig, isMetisConfigTable, metisConfigPath, readMetisConfig, updateMetisConfig } from "../configuration/store.ts";

export type ExecutionConfig = {
  tools: { autoReasoning: boolean; customRustBinariesDir: string };
  ui: { toolRenaming: boolean; backgroundShellWidget: boolean; backgroundShellToggleShortcut: string;
    backgroundShellPrevShortcut: string; backgroundShellNextShortcut: string; backgroundShellCloseShortcut: string };
};
export const EXECUTION_DEFAULTS = defaultMetisConfig()["execution"] as ExecutionConfig;
export const executionConfigPath = () => metisConfigPath(getAgentDir());
export function readExecutionConfig(): ExecutionConfig {
  const config = structuredClone(EXECUTION_DEFAULTS), section = readMetisConfig(getAgentDir()).config["execution"];
  for (const group of ["tools", "ui"] as const) for (const key of Object.keys(config[group])) {
    const source = isMetisConfigTable(section) ? section[group] : undefined;
    const value = isMetisConfigTable(source) ? source[key] : undefined, target = config[group] as Record<string, unknown>;
    if (typeof value === typeof target[key]) target[key] = value;
  }
  return config;
}
export function writeExecutionConfig(config: { tools?: Partial<ExecutionConfig["tools"]>; ui?: Partial<ExecutionConfig["ui"]> }): void {
  updateMetisConfig(getAgentDir(), { execution: config });
}
