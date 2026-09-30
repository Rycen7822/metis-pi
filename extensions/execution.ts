import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readExecutionConfig, writeExecutionConfig } from "../src/execution/config.ts";
import { createExecSessionManager } from "../src/execution/exec/session-manager.ts";
import { createExecCommandTracker } from "../src/execution/exec/command-state.ts";
import { getBundledToolBinaryPath } from "../src/execution/native/binary.ts";
import { createApplyPatchTool, registerApplyPatchResultEvent } from "../src/execution/apply-patch/tool.ts";
import { createExecCommandTool } from "../src/execution/exec/command-tool.ts";
import { createWriteStdinTool } from "../src/execution/exec/write-stdin-tool.ts";
import { createViewImageTool } from "../src/execution/view-image/tool.ts";
import { registerImageHints } from "../src/execution/view-image/hints.ts";
import { createAutoReasoning } from "../src/execution/auto-reasoning.ts";
import { registerExecutionCodeMode } from "../src/execution/code-mode.ts";
import { isActionFusionEnabled } from "../src/execution/action-fusion-availability.ts";
import { runExecFusionCommand } from "../src/execution/action-fusion-command.ts";
import { registerBackgroundShellUi } from "../src/execution/ui/background-shell.ts";

export default async function execution(pi: ExtensionAPI): Promise<void> {
  const runtime: import("../src/execution/runtime.ts").ExecutionRuntime = { config: readExecutionConfig(), tracker: createExecCommandTracker(),
    sessions: createExecSessionManager({ bridgeBinaryPath: () => getBundledToolBinaryPath("exec_bridge", {}, runtime.config.tools.customRustBinariesDir) }) };
  const register = (tool: ToolDefinition) => pi.registerTool({ ...tool, exposure: "codemode" });
  const registerCore = () => {
    const config = runtime.config;
    register(createApplyPatchTool({ customRustBinariesDir: config.tools.customRustBinariesDir,
      showDiffWhenCollapsed: config.ui.compactTools === "off",
      runThenRun: isActionFusionEnabled(pi) ? ctx => (input, signal, update) => runExecFusionCommand(runtime.sessions, input, ctx, signal, update) : undefined }));
    register(createExecCommandTool(runtime.tracker, runtime.sessions, { customRendering: config.ui.toolRenaming, showOutputWhenCollapsed: true }));
    register(createWriteStdinTool(runtime.sessions, { showOutputWhenCollapsed: true }));
    register(createViewImageTool({ customRustBinariesDir: config.tools.customRustBinariesDir,
      describeForTextModels: config.tools.viewImageFallback, customRendering: config.ui.toolRenaming }));
  };
  registerCore(); registerApplyPatchResultEvent(pi); registerImageHints(pi);
  const reasoning = createAutoReasoning(pi, () => runtime.config.tools.autoReasoning);
  runtime.reasoning = reasoning.tool;
  pi.registerTool(reasoning.tool);
  const codeMode = await registerExecutionCodeMode(pi, runtime);

  const offExit = runtime.sessions.onSessionExit(sessionId => runtime.tracker.recordSessionFinished(sessionId));
  const offBusy = pi.events.on("metis:execution-status", (request: any) => { request.busy ||= runtime.sessions.listSessions(0).some(session => session.running); });
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    const config = readExecutionConfig(ctx);
    if (JSON.stringify(config) !== JSON.stringify(runtime.config)) { runtime.config = config; registerCore(); }
  };
  pi.on("session_start", (event, ctx) => { refresh(event, ctx); registerCore(); });
  const widget = registerBackgroundShellUi(pi, runtime);
  pi.on("model_select", refresh); pi.on("session_tree", refresh);
  pi.on("before_agent_start", (event, ctx) => { refresh(event, ctx); reasoning.begin(ctx); });
  pi.on("agent_end", (_event, ctx) => reasoning.settle(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    reasoning.settle(ctx); widget.shutdown(); offExit(); offBusy();
    const outcomes = await Promise.allSettled([codeMode.shutdown(), runtime.sessions.shutdown()]);
    const failures = outcomes.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Execution cleanup failed");
  });
  pi.registerCommand("execution", { description: "Configure metis execution tools", async handler(args, ctx) {
    if (!ctx.hasUI) { ctx.ui.notify("Edit metis-pi.json.execution to configure execution tools", "info"); return; }
    const project = args.trim() === "project";
    if (project && !ctx.isProjectTrusted()) { ctx.ui.notify("Trust the project before changing its execution settings", "warning"); return; }
    const draft = structuredClone(project ? runtime.config : readExecutionConfig());
    const fields = Object.entries(draft).flatMap(([group, values]) => Object.keys(values).map(key => ({ group, key })));
    const selected = await ctx.ui.select("Execution settings", fields.map(({ group, key }) => `${group}.${key}`));
    const field = fields.find(({ group, key }) => `${group}.${key}` === selected);
    if (!field) return;
    const values = draft[field.group as keyof typeof draft] as Record<string, any>, current = values[field.key];
    const value = typeof current === "boolean" ? await ctx.ui.select(field.key, ["on", "off"])
      : field.key === "compactTools" ? await ctx.ui.select(field.key, ["off", "compact", "minimal"])
      : await ctx.ui.input(field.key, current);
    if (value === undefined) return;
    values[field.key] = typeof current === "boolean" ? value === "on" : value;
    writeExecutionConfig({ [field.group]: { [field.key]: values[field.key] } }, project ? ctx.cwd : undefined);
    refresh(undefined, ctx);
    ctx.ui.notify(field.key.endsWith("Shortcut") ? "Saved; restart Pi to apply shortcut changes" : "Execution settings saved", "info");
  } });
}
