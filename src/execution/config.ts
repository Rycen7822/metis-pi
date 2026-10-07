import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultMetisConfig, metisConfigPath, readMetisConfig, updateMetisConfig } from "../metis-config.ts";

export type ExecutionConfig = {
  tools: { autoReasoning: boolean; customRustBinariesDir: string; viewImageFallback: boolean };
  ui: { toolRenaming: boolean; backgroundShellWidget: boolean; backgroundShellToggleShortcut: string;
    backgroundShellPrevShortcut: string; backgroundShellNextShortcut: string; backgroundShellCloseShortcut: string };
};
export const EXECUTION_DEFAULTS = defaultMetisConfig()["execution"] as ExecutionConfig;
export const executionConfigPath = () => metisConfigPath(getAgentDir());
export function readExecutionConfig(_ctx?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExecutionConfig {
  const config = structuredClone(EXECUTION_DEFAULTS), section = readMetisConfig(getAgentDir()).config["execution"];
  for (const group of ["tools", "ui"] as const) for (const key of Object.keys(config[group])) {
    const value = section?.[group]?.[key], target = config[group] as Record<string, unknown>;
    if (typeof value === typeof target[key]) target[key] = value;
  }
  return config;
}
export function writeExecutionConfig(config: { tools?: Partial<ExecutionConfig["tools"]>; ui?: Partial<ExecutionConfig["ui"]> }): void {
  updateMetisConfig(getAgentDir(), { execution: config });
}
