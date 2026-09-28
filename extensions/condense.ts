import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import registerCondense from "../vendor/pi-condense/index.ts";

/** Defer registration until Pi can identify an already installed recovery tool. */
export default function condense(pi: ExtensionAPI): void {
  let initialized = false;
  const starts: Array<(event: SessionStartEvent, ctx: ExtensionContext) => unknown> = [];
  let context: ExtensionContext | undefined;

  const unsubscribe = pi.events.on("cost:external", (event: unknown) => {
    const cost = event as { source?: string; totalCost?: number; inputTokens?: number; outputTokens?: number } | null;
    if (!initialized || !context || cost?.source !== "pi-condense") return;
    const tokens = [cost.inputTokens, cost.outputTokens].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
    const amount = typeof cost.totalCost === "number" && Number.isFinite(cost.totalCost) && cost.totalCost > 0
      ? ` · $${cost.totalCost.toFixed(4)}` : "";
    context.ui.setStatus("metis-condense-cost", `prune usage: ${tokens.reduce((sum, n) => sum + n, 0)} tokens${amount} (since session load)`);
  });

  pi.on("session_start", async (event, ctx) => {
    context = ctx;
    ctx.ui.setStatus("metis-condense-cost", undefined);
    if (!initialized) {
      if (pi.getAllTools().some((tool) => tool.name === "context_tree_query")) {
        ctx.ui.notify("metis-pi: external context_tree_query detected; built-in condense is inactive. Remove the separate pi-condense installation and reload to use the built-in version. Existing configuration and archives are preserved.", "warning");
        return;
      }
      // The upstream entry owns subsequent lifecycle handlers. Run its initial
      // session_start explicitly: appending to an in-flight event list is unsafe.
      const adapter = new Proxy(pi, {
        get(target, key) {
          if (key === "on") return (name: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown) => {
            if (name === "session_start") {
              starts.push(handler);
              return () => { const i = starts.indexOf(handler); if (i >= 0) starts.splice(i, 1); };
            }
            return (target.on as (name: string, handler: unknown) => () => void)(name, handler);
          };
          return Reflect.get(target, key);
        },
      });
      registerCondense(adapter);
      initialized = true;
    }
    for (const start of starts) await start(event, ctx);
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    unsubscribe();
  });
  pi.on("session_tree", () => context?.ui.setStatus("metis-condense-cost", undefined));
}
