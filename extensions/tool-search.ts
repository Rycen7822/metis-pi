import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { OWNED_TOOL_SEARCH_ENTRY } from "../src/presentation/tool-source.mjs";
import { catalogNotice, snapshot, type CatalogSnapshot } from "../src/tool-discovery/context.ts";
import { createToolSearchDefinition } from "../src/tool-discovery/definition.ts";
import { TOOL_SEARCH_NAME } from "../src/tool-discovery/search.ts";

const CATALOG_MESSAGE = "metis-tool-catalog";

export default function toolSearch(pi: ExtensionAPI): void {
  let baseline: CatalogSnapshot | undefined;
  let pending: CatalogSnapshot | undefined;
  pi.registerTool(createToolSearchDefinition(pi, tool => {
    // A nested describe observes a definition; it does not acknowledge that a change notice reached the model.
    if (!baseline || baseline.parameters.has(tool.name)) return;
    const parameters = JSON.stringify(tool.parameters);
    baseline.parameters.set(tool.name, parameters);
    if (pending && !pending.parameters.has(tool.name)) pending.parameters.set(tool.name, parameters);
  }));
  const owned = (tool: ToolInfo | undefined) => tool?.sourceInfo.path === OWNED_TOOL_SEARCH_ENTRY;

  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    const tool = tools.find(candidate => candidate.name === TOOL_SEARCH_NAME);
    pending = undefined;
    if (!owned(tool)) {
      baseline = undefined;
      if (tool) ctx.ui.notify(`Metis tool_search inactive: tool_search is provided by ${tool.sourceInfo.path}.`, "warning");
      return;
    }
    // Registered inactive for codemode exposure; direct calls need activation in every codemode mode.
    if (!pi.getActiveTools().includes(TOOL_SEARCH_NAME))
      pi.setActiveTools([...pi.getActiveTools(), TOOL_SEARCH_NAME]);
    baseline = snapshot(tools, pi.getActiveTools());
  });

  pi.on("context", event => {
    const previous = baseline;
    const tools = pi.getAllTools();
    pending = undefined;
    if (!previous || !owned(tools.find(tool => tool.name === TOOL_SEARCH_NAME))) return;
    pending = snapshot(tools, pi.getActiveTools(), previous);
    const notice = catalogNotice(previous, pending);
    if (!notice) return;
    return { messages: [...event.messages, {
      role: "custom" as const, customType: CATALOG_MESSAGE, content: notice, display: false, timestamp: Date.now(),
    }] };
  });

  pi.on("message_end", ({ message }) => {
    // A prepared request can fail before the model sees it; keep its delta for a retry.
    if (message.role !== "assistant") return;
    if (pending && message.stopReason !== "error" && message.stopReason !== "aborted") baseline = pending;
    pending = undefined;
  });
  pi.on("session_shutdown", () => {
    baseline = pending = undefined;
  });
}
