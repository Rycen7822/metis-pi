import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory } from "./renderers.ts";

export interface AppearanceAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    hasUI: boolean; ui: { notify(text: string, level: "warning"): void };
  }) => void): void;
  getAllTools(): readonly unknown[];
}
export interface Bindings { prototype: object; makeText: TextFactory; expandHint(): string; highlight?: Highlight; makeDiff?: DiffFactory }

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let handle: AdapterHandle | undefined;
  pi.on("session_start", (_event, ctx) => {
    enabled = ctx.hasUI;
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff),
    });
    if (!handle.installed) ctx.ui.notify(`pi-codex-appearance: ${handle.reason}. Compact transcript was not installed.`, "warning");
  });
  pi.on("session_shutdown", () => {
    enabled = false;
    handle?.dispose();
    handle = undefined;
  });
}
