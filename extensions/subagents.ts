import { getAgentDir, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { runtimePackage } from "../src/subagents/client.ts";
import { SubagentSession } from "../src/subagents/session.ts";
import { subagentToolRenderers } from "../src/subagents/rendering.ts";

export default function subagents(pi: ExtensionAPI) {
  if (process.env.PI_AGENTS_MANAGED_CHILD === "1" || process.platform !== "linux") return;
  const agentDir = getAgentDir();
  let runtime: ReturnType<typeof runtimePackage>;
  try { runtime = runtimePackage(); }
  catch (error) { pi.on("session_start", (_event, ctx) => { ctx.ui.notify(`Metis subagents unavailable: ${String(error)}`, "warning"); }); return; }
  let owner: SubagentSession | undefined, blocked = false;
  const ownNames = new Set(runtime.tools.map(tool => tool.name));
  const ownPath = fileURLToPath(import.meta.url);
  const conflict = () => pi.getAllTools().some(tool => /(?:^|\/)pi-subagents(?:\/|$)/.test(tool.sourceInfo.path) || ["Agent", "SubagentWorkflow", "subagent"].includes(tool.name) || (ownNames.has(tool.name) && tool.sourceInfo.path !== ownPath));
  const definitions: ToolDefinition[] = runtime.tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    outputSchema: tool.outputSchema, annotations: tool.annotations, executionMode: "parallel",
    ...subagentToolRenderers(tool.name),
    execute: async (id, args, signal, _update, ctx) => {
      if (blocked || conflict()) throw new Error("Another subagent provider is enabled; choose one in pi config and reload");
      if (!owner) throw new Error("Subagent parent session is not attached");
      return owner.execute(tool.name, args as Record<string, unknown>, id, ctx, signal);
    },
  }));
  pi.on("session_start", async (_event, ctx) => {
    await owner?.close(); owner = undefined; blocked = conflict();
    if (blocked) {
      for (const definition of definitions) if (pi.getAllTools().some(tool => tool.name === definition.name && tool.sourceInfo.path === ownPath)) pi.registerTool({ ...definition, exposure: "hidden" });
      ctx.ui.notify("Metis subagents inactive: another provider is loaded. Choose one in pi config and reload.", "warning"); return;
    }
    for (const definition of definitions) pi.registerTool(definition);
    owner = new SubagentSession(pi, runtime, ctx, agentDir);
  });
  pi.on("session_shutdown", async () => { await owner?.close(); owner = undefined; });
  pi.on("before_agent_start", async (_event, ctx) => {
    if (conflict()) {
      blocked = true; await owner?.close(); owner = undefined;
      for (const definition of definitions) if (pi.getAllTools().some(tool => tool.name === definition.name && tool.sourceInfo.path === ownPath)) pi.registerTool({ ...definition, exposure: "hidden" });
    }
    owner?.update(ctx);
  });
  pi.on("tool_result", event => owner?.result(event));
  pi.on("turn_end", async (_event, ctx) => { await owner?.settled(ctx); });
  pi.on("agent_before_settle", (event, ctx) => owner?.beforeSettle(event, ctx));
  pi.on("agent_settled", async (_event, ctx) => { await owner?.settled(ctx, true); });
  pi.registerCommand("metis-subagents", { description: "Subagent status; stop <agent>; continue <agent> <task>; answer <agent>", handler: async (args, ctx) => {
    if (!owner || blocked) { ctx.ui.notify("Metis subagents inactive; choose one provider in pi config and reload", "warning"); return; }
    try { await owner.command(args, ctx); } catch (error) { ctx.ui.notify(String(error), "error"); }
  } });
}
