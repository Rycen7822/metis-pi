// Metis-owned Neural Search; upstream and maintenance notes: src/neural-search/METIS.md.
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDeferredActionTool } from "../src/deferred-action-tool.ts";
import createNeuralSearch, { SEARCH_TOOL_NAME as name } from "../src/neural-search/index.ts";
const ownerPath = fileURLToPath(import.meta.url);
const description = "Local fuzzy file/path and content search, with git-aware frecency ranking.";

export default function neuralSearch(pi: ExtensionAPI): void {
  const available = () => !pi.getAllTools().some(tool => tool.name === name && tool.sourceInfo.path !== ownerPath);
  const actions = createNeuralSearch(pi, available);
  if (!actions) return;
  const definition = {
    ...createDeferredActionTool(name, description, actions),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };

  const owned = () => pi.getAllTools().some(tool => tool.name === name && tool.sourceInfo.path === ownerPath);
  const nativeSearch = () => pi.getAllTools().some(tool =>
    tool.name === "tool_search" && tool.sourceInfo.path === "builtin:tool_search");
  let lastWarning: string | undefined;
  const diagnose = (ctx: ExtensionContext, warning?: string) => {
    if (warning && warning !== lastWarning) ctx.ui.notify(warning, "warning");
    lastWarning = warning;
  };
  pi.on("session_start", (_event, ctx) => {
    if (!available()) {
      diagnose(ctx, "Metis Neural Search inactive: another neural_search provider is loaded.");
      return;
    }
    pi.registerTool(definition);
    // The managed surface owner has already applied and attested the profile.
    if (process.env.PI_AGENTS_MANAGED_CHILD !== "1" && owned() && nativeSearch() && !pi.getActiveTools().includes("tool_search"))
      pi.setActiveTools([...pi.getActiveTools(), "tool_search"]);
    if (pi.getAllTools().some(tool => tool.sourceInfo.source.startsWith("npm:@ff-labs/pi-fff")))
      ctx.ui.notify("Standalone pi-fff is also loaded. Remove that package when switching to Metis Neural Search to avoid duplicate tools and indexes.", "warning");
  });
  pi.on("before_agent_start", (event, ctx) => {
    delete event.systemPromptOptions.sections.metis_neural_search;
    if (!owned()) {
      diagnose(ctx, "Metis Neural Search inactive: another provider owns neural_search.");
      return;
    }
    const ready = nativeSearch() && pi.getActiveTools().includes("tool_search");
    if (process.env.PI_AGENTS_MANAGED_CHILD === "1" && !ready) { diagnose(ctx); return; }
    diagnose(ctx, ready ? undefined : "Metis Neural Search needs Pi's native tool_search enabled for discovery and direct calls.");
    event.systemPromptOptions.sections.metis_neural_search = ready
      ? `${name}: ${description} Discover with tool_search, then call directly. Use action=describe to load an action's parameters.`
      : `${name}: ${description} Enable Pi's native tool_search to discover it before direct calls.`;
  });
}
