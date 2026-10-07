import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readExecutionConfig, writeExecutionConfig } from "../src/execution/config.ts";
import { createExecSessionManager } from "../src/execution/exec/session-manager.ts";
import { getBundledToolBinaryPath } from "../src/execution/native/binary.ts";
import { createExecCommandTool } from "../src/execution/exec/command-tool.ts";
import { createWriteStdinTool } from "../src/execution/exec/write-stdin-tool.ts";
import { createViewImageTool } from "../src/execution/view-image/tool.ts";
import { registerImageHints } from "../src/execution/view-image/hints.ts";
import { createAutoReasoning } from "../src/execution/auto-reasoning.ts";
import { registerBackgroundShellUi } from "../src/execution/ui/background-shell.ts";

export default function execution(pi: ExtensionAPI): void {
  const runtime: import("../src/execution/runtime.ts").ExecutionRuntime = { config: readExecutionConfig(),
    sessions: createExecSessionManager({ bridgeBinaryPath: () => getBundledToolBinaryPath("exec_bridge", {}, runtime.config.tools.customRustBinariesDir) }) };
  const register = (tool: ToolDefinition) => pi.registerTool({ ...tool, exposure: "deferred" });
  const registerCore = () => {
    const config = runtime.config;
    register(createExecCommandTool(runtime.sessions, { customRendering: config.ui.toolRenaming, showOutputWhenCollapsed: true }));
    register(createWriteStdinTool(runtime.sessions, { showOutputWhenCollapsed: true }));
    register(createViewImageTool({ customRustBinariesDir: config.tools.customRustBinariesDir,
      describeForTextModels: config.tools.viewImageFallback, customRendering: config.ui.toolRenaming }));
  };
  registerCore(); registerImageHints(pi);
  const reasoning = createAutoReasoning(pi, () => runtime.config.tools.autoReasoning);
  pi.registerTool(reasoning.tool);

  const offBusy = pi.events.on("metis:execution-status", (request: any) => { request.busy ||= runtime.sessions.listSessions(0).some(session => session.running); });
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    const config = readExecutionConfig(ctx);
    if (JSON.stringify(config) !== JSON.stringify(runtime.config)) { runtime.config = config; registerCore(); }
    pi.registerTool({ ...reasoning.tool, exposure: config.tools.autoReasoning && ctx.model?.reasoning ? "deferred" : "hidden" });
  };
  pi.on("session_start", (event, ctx) => { refresh(event, ctx); registerCore(); });
  const widget = registerBackgroundShellUi(pi, runtime);
  pi.on("model_select", refresh); pi.on("session_tree", refresh);
  pi.on("before_agent_start", (event, ctx) => { refresh(event, ctx); reasoning.begin(ctx); });
  pi.on("agent_end", (_event, ctx) => reasoning.settle(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    reasoning.settle(ctx); widget.shutdown(); offBusy();
    await runtime.sessions.shutdown();
  });
  pi.registerCommand("execution", { description: "Configure metis execution tools", async handler(args, ctx) {
    if (args.trim()) { ctx.ui.notify("Execution settings are global only. Use /execution without project arguments.", "warning"); return; }
    if (!ctx.hasUI) { ctx.ui.notify("Edit [execution] in metis-pi.toml to configure execution tools", "info"); return; }
    const draft = structuredClone(readExecutionConfig());
    const fields = Object.entries(draft).flatMap(([group, values]) => Object.keys(values).map(key => ({ group, key })));
    const selected = await ctx.ui.select("Execution settings", fields.map(({ group, key }) => `${group}.${key}`));
    const field = fields.find(({ group, key }) => `${group}.${key}` === selected);
    if (!field) return;
    const values = draft[field.group as keyof typeof draft] as Record<string, any>, current = values[field.key];
    const value = typeof current === "boolean" ? await ctx.ui.select(field.key, ["on", "off"]) : await ctx.ui.input(field.key, current);
    if (value === undefined) return;
    values[field.key] = typeof current === "boolean" ? value === "on" : value;
    writeExecutionConfig({ [field.group]: { [field.key]: values[field.key] } });
    refresh(undefined, ctx);
    ctx.ui.notify(field.key.endsWith("Shortcut") ? "Saved; restart Pi to apply shortcut changes" : "Execution settings saved", "info");
  } });
}
