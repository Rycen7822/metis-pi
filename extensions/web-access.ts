// Upstream: https://github.com/nicobailon/pi-web-access (see src/pi-web-access/METIS.md).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import initialize from "../src/pi-web-access/dist/index.js";
import { createDeferredActionTool, type ActionTool } from "../src/deferred-action-tool.ts";
import { webToolBody, webToolCall } from "../src/pi-web-access/tool-layout.ts";

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
    const tool = createDeferredActionTool("web_access", `Web access: ${capabilities}.`, actions);
    const renderCall = tool.renderCall, renderResult = tool.renderResult;
    if (renderCall) tool.renderCall = (input, theme, context) => {
      if (actions.get(input.action)?.renderCall) return renderCall(input, theme, context);
      const title = theme.fg("toolTitle", `web_access ${input.action ?? ""}`);
      return webToolCall(title, input.target ? [theme.fg("accent", input.target)] : []);
    };
    if (renderResult) tool.renderResult = (result, options, theme, context) => {
      const component = renderResult(result, options, theme, context);
      const action = result.details?.metisAction;
      const hasActionRenderer = typeof action === "string" && actions.get(action)?.renderResult;
      return hasActionRenderer ? component : webToolBody(component);
    };
    pi.registerTool(tool);
  }
}
