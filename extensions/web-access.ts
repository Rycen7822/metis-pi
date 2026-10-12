// Upstream: https://github.com/nicobailon/pi-web-access (see src/pi-web-access/METIS.md).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import initialize from "../src/pi-web-access/dist/index.js";
import { createDeferredActionTool, type ActionTool } from "../src/deferred-action-tool.ts";

export default function webAccess(pi: ExtensionAPI): void {
  const actions = new Map<string, ActionTool>();
  initialize(pi, {
    registerTool: (action: string, tool: ActionTool) => { actions.set(action, tool); },
    toolName: "web_access",
    formatStoredContentCall: (args: string) => `tools.web_access({ action: "content", params: { ${args} } })`,
  });
  if (actions.size) {
    const capabilities = [
      actions.has("search") && "search the web",
      actions.has("source_check") && "check sources",
      actions.has("fetch") && "fetch content",
      actions.has("content") && "retrieve stored content",
    ].filter(Boolean).join(", ");
    pi.registerTool(createDeferredActionTool("web_access", `Web access: ${capabilities}.`, actions));
  }
}
