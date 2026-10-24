import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMetisConfigTable, readMetisConfig } from "../src/configuration/store.ts";
import { loadConfig } from "../src/appearance/config.ts";
import { runtimePackage } from "../src/subagents/host/runtime-package.ts";
import { subagentAttentionRenderer, subagentToolRenderers } from "../src/subagents/ui/rendering.ts";
import { SubagentSession } from "../src/subagents/host/session.ts";

const namespace = {
  name: "subagents",
  description: "Create, observe, message, answer and interrupt persistent Pi subagents in this parent session.",
};
const guidance = "Subagent tools are deferred in the subagents namespace. Use codemode: discover with describeNamespace('subagents') or searchTools(query, {namespace:'subagents', limit:1}), then call tools.subagents_<operation>(args). Use the subagent-delegation skill before spawning or assigning work. Check result.isError and preserve IDs, request_id, errors, questions and not_consumed inputs in output. Partial script success is not rolled back; do not blindly rerun mutations.";

export default function subagents(pi: ExtensionAPI) {
  if (process.env.PI_AGENTS_MANAGED_CHILD === "1" || (process.platform !== "linux" && process.platform !== "win32")) return;
  const agentDir = getAgentDir();
  let runtime: ReturnType<typeof runtimePackage>;
  try {
    const section = readMetisConfig(agentDir).config["subagents"];
    const enabled = isMetisConfigTable(section) ? section["enabled"] : undefined;
    if (typeof enabled !== "boolean") throw new Error("subagents.enabled must be a boolean");
    if (!enabled) return;
    pi.registerMessageRenderer("metis-subagent-attention", subagentAttentionRenderer);
    runtime = runtimePackage();
  } catch (error) {
    pi.on("session_start", (_event, ctx) => { ctx.ui.notify(`Metis subagents unavailable: ${String(error)}`, "warning"); }); return;
  }
  let owner: SubagentSession | undefined, blocked = false;
  // Appearance preferences are re-read per use, never cached at session start:
  // the next widget render or viewer open sees a mid-session config edit. An
  // absent or unreadable file still degrades to defaults inside loadConfig.
  const readAppearance = () =>
    loadConfig(agentDir, (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    }).config;
  let warnedCodemode = false;
  const codemodeReady = (ctx: ExtensionContext, activate = false) => {
    const active = pi.getActiveTools();
    const native = pi.getAllTools().some(tool => tool.name === "codemode" && tool.sourceInfo.path === "builtin:codemode");
    if (native && activate && !active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
    const ready = native && pi.getActiveTools().includes("codemode");
    if (!ready && !warnedCodemode) {
      ctx.ui.notify("Metis subagents use deferred tools and need native codemode. Enable builtin:codemode and allow the codemode tool.", "warning");
      warnedCodemode = true;
    }
    return ready;
  };
  const ownNames = new Set(runtime.tools.map(tool => tool.name));
  const ownPath = fileURLToPath(import.meta.url);
  const hasTools = () => pi.getAllTools().some(tool => ownNames.has(tool.name) && tool.sourceInfo.path === ownPath && tool.exposure === "deferred");
  const conflict = () =>
    pi
      .getAllTools()
      .some(
        (tool) =>
          /(?:^|\/)pi-subagents(?:\/|$)/.test(tool.sourceInfo.path) ||
          ["Agent", "SubagentWorkflow", "subagent"].includes(tool.name) ||
          (ownNames.has(tool.name.replace(/^pi_/, "subagents_")) && tool.sourceInfo.path !== ownPath),
      );
  const definitions: ToolDefinition[] = runtime.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    namespace,
    exposure: "deferred",
    executionMode: "parallel",
    ...subagentToolRenderers(tool.name),
    execute: async (id, args, signal, _update, ctx) => {
      if (blocked || conflict())
        throw new Error("Another subagent provider is enabled; choose one in pi config and reload");
      if (!owner) throw new Error("Subagent parent session is not attached");
      return owner.execute(tool.name, args as Record<string, unknown>, id, ctx, signal);
    },
  }));
  pi.on("session_start", async (_event, ctx) => {
    await owner?.close();
    owner = undefined;
    warnedCodemode = false;
    blocked = conflict();
    if (blocked) {
      for (const definition of definitions)
        if (pi.getAllTools().some((tool) => tool.name === definition.name && tool.sourceInfo.path === ownPath))
          pi.registerTool({ ...definition, exposure: "hidden" });
      ctx.ui.notify(
        "Metis subagents inactive: another provider is loaded. Choose one in pi config and reload.",
        "warning",
      );
      return;
    }
    for (const definition of definitions) pi.registerTool(definition);
    owner = new SubagentSession(pi, runtime, ctx, agentDir, readAppearance);
    if (hasTools()) codemodeReady(ctx, true);
  });
  pi.on("resources_discover", () => {
    if (owner && !conflict() && hasTools()) {
      return { skillPaths: [fileURLToPath(new URL("../src/subagents/skills/subagent-delegation/SKILL.md", import.meta.url))] };
    }
  });
  pi.on("session_shutdown", async () => {
    await owner?.close();
    owner = undefined;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    delete event.systemPromptOptions.sections.metis_subagents;
    if (conflict()) {
      blocked = true;
      await owner?.close();
      owner = undefined;
      for (const definition of definitions)
        if (pi.getAllTools().some((tool) => tool.name === definition.name && tool.sourceInfo.path === ownPath))
          pi.registerTool({ ...definition, exposure: "hidden" });
    }
    owner?.update(ctx);
    if (owner && hasTools() && codemodeReady(ctx)) event.systemPromptOptions.sections.metis_subagents = guidance;
  });
  pi.on("tool_result", (event) => owner?.result(event));
  pi.on("turn_end", (event, ctx) => owner?.boundary(event, ctx));
  pi.on("agent_before_settle", (event, ctx) => owner?.boundary(event, ctx));
  pi.on("agent_settled", async (_event, ctx) => {
    await owner?.settled(ctx, true);
  });
  pi.registerCommand("metis-subagents", {
    description: "Subagent status; stop <agent>; continue <agent> <task>; answer <agent>",
    handler: async (args, ctx) => {
      if (!owner || blocked) {
        ctx.ui.notify("Metis subagents inactive; choose one provider in pi config and reload", "warning");
        return;
      }
      try {
        await owner.command(args, ctx);
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
