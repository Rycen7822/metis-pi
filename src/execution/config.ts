import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EXECUTION_DEFAULTS = {
  tools: { autoReasoning: false, customRustBinariesDir: "", viewImageFallback: false },
  ui: { toolRenaming: true,
    backgroundShellWidget: true, backgroundShellToggleShortcut: "alt+w", backgroundShellPrevShortcut: "alt+q",
    backgroundShellNextShortcut: "alt+e", backgroundShellCloseShortcut: "alt+r" },
};
export type ExecutionConfig = typeof EXECUTION_DEFAULTS;
export const executionConfigPath = (cwd?: string) => cwd ? join(cwd, ".pi", "metis-pi.json") : join(getAgentDir(), "metis-pi.json");
function read(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Invalid settings object: ${path}`);
  return data;
}
function merge(config: ExecutionConfig, section: any): ExecutionConfig {
  const result = structuredClone(config);
  for (const group of ["tools", "ui"] as const) {
    for (const key of Object.keys(result[group])) {
      const value = section?.[group]?.[key];
      const target = result[group] as Record<string, unknown>;
      if (typeof value !== typeof target[key]) continue;
      target[key] = value;
    }
  }
  return result;
}
export function readExecutionConfig(ctx?: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): ExecutionConfig {
  let config = merge(EXECUTION_DEFAULTS, read(executionConfigPath())["execution"]);
  if (ctx?.isProjectTrusted()) config = merge(config, read(executionConfigPath(ctx.cwd))["execution"]);
  return config;
}
export function writeExecutionConfig(config: { tools?: Partial<ExecutionConfig["tools"]>; ui?: Partial<ExecutionConfig["ui"]> }, cwd?: string): void {
  const path = executionConfigPath(cwd), data = read(path);
  data["execution"] = { ...data["execution"], tools: { ...data["execution"]?.tools, ...config.tools }, ui: { ...data["execution"]?.ui, ...config.ui } };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
