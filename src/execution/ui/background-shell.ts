import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecutionRuntime } from "../runtime.ts";
import { BACKGROUND_BASH_WIDGET_ID, registerBackgroundBashWidgetShortcuts, renderBackgroundBashWidget, type BackgroundBashWidgetState } from "./background-shell-widget.ts";
export function registerBackgroundShellUi(pi: ExtensionAPI, runtime: ExecutionRuntime) {
  const state: BackgroundBashWidgetState = { folded: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const render = () => {
    if (state.ctx) {
      if (runtime.config.ui.backgroundShellWidget) renderBackgroundBashWidget(state.ctx, state, runtime.sessions);
      else state.ctx.ui.setWidget(BACKGROUND_BASH_WIDGET_ID, undefined);
    }
  };
  let keysRegistered = false;
  const off = runtime.sessions.onSessionChange(reason => {
    if (reason !== "output") { cancel(); render(); }
    else if (!timer) timer = setTimeout(() => { timer = undefined; render(); }, 250);
  });
  pi.on("session_start", (_event, ctx) => {
    if (!keysRegistered) { keysRegistered = true; registerBackgroundBashWidgetShortcuts(pi, state, runtime.sessions, runtime.config.ui, () => runtime.config.ui.backgroundShellWidget); }
    cancel(); state.ctx?.ui.setWidget(BACKGROUND_BASH_WIDGET_ID, undefined); state.ctx = ctx; render(); });
  pi.on("session_tree", (_event, ctx) => { cancel(); state.ctx = ctx; render(); });
  pi.on("before_agent_start", () => render());
  return { shutdown() { cancel(); off(); state.ctx?.ui.setWidget(BACKGROUND_BASH_WIDGET_ID, undefined); state.ctx = undefined; } };
}
