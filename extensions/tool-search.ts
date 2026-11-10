// Metis-owned unified tool discovery; ranking and detail contract live in src/tool-discovery/.
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { OWNED_TOOL_SEARCH_ENTRY } from "../src/presentation/tool-source.mjs";
import { catalogNotice, visibleNames } from "../src/tool-discovery/context.ts";
import { createToolSearchDefinition } from "../src/tool-discovery/definition.ts";
import { TOOL_SEARCH_NAME } from "../src/tool-discovery/search.ts";

const CATALOG_MESSAGE = "metis-tool-catalog";

export default function toolSearch(pi: ExtensionAPI): void {
  pi.registerTool(createToolSearchDefinition(pi));
  let baseline: Set<string> | undefined;
  let pending: Set<string> | undefined;
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
    baseline = visibleNames(tools, pi.getActiveTools());
  });

  pi.on("context", event => {
    const previous = baseline;
    const tools = pi.getAllTools();
    pending = undefined;
    if (!previous || !owned(tools.find(tool => tool.name === TOOL_SEARCH_NAME))) return;
    const current = visibleNames(tools, pi.getActiveTools());
    const added = [...current].filter(name => !previous.has(name));
    const removed = [...previous].filter(name => !current.has(name));
    const notice = catalogNotice(added, removed);
    if (!notice) return;
    pending = current;
    return { messages: [...event.messages, {
      role: "custom" as const, customType: CATALOG_MESSAGE, content: notice, display: false, timestamp: Date.now(),
    }] };
  });

  pi.on("message_end", ({ message }) => {
    // A prepared request can fail before the model sees it; keep its delta for a retry.
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return;
    if (pending) baseline = pending;
    pending = undefined;
  });
  pi.on("session_shutdown", () => {
    baseline = pending = undefined;
  });
}
