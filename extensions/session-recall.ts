// Upstream: https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-session-recall.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import initialize from "../src/pi-session-recall/session-recall.ts";
import { createDeferredActionTool, type ActionTool } from "../src/deferred-action-tool.ts";

export default function sessionRecall(pi: ExtensionAPI): void {
  const actions = new Map<string, ActionTool>();
  initialize(pi, {
    registerTool: (action, tool) => { actions.set(action, tool); },
    toolName: "session_recall",
  });
  pi.registerTool(createDeferredActionTool(
    "session_recall", "Search past sessions by literal text or query a selected session with an LLM.", actions,
  ));
}
