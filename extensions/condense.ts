import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCondenseRuntime } from "../src/condense/runtime.ts";

/** Defer registration until Pi can identify an already installed recovery tool. */
export default function condense(pi: ExtensionAPI): void {
  let runtime: ReturnType<typeof createCondenseRuntime> | undefined;
  let context: ExtensionContext | undefined;

  const unsubscribe = pi.events.on("cost:external", (event: unknown) => {
    const cost = event as { source?: string; totalCost?: number; inputTokens?: number; outputTokens?: number } | null;
    if (!runtime || !context || cost?.source !== "pi-condense") return;
    const tokens = [cost.inputTokens, cost.outputTokens].filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0);
    const amount = typeof cost.totalCost === "number" && Number.isFinite(cost.totalCost) && cost.totalCost > 0
      ? ` · $${cost.totalCost.toFixed(4)}` : "";
    context.ui.setStatus("metis-condense-cost", `prune usage: ${tokens.reduce((sum, n) => sum + n, 0)} tokens${amount} (since session load)`);
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    ctx.ui.setStatus("metis-condense-cost", undefined);
    if (!runtime) {
      if (pi.getAllTools().some((tool) => tool.name === "context_tree_query")) {
        ctx.ui.notify("metis-pi: external context_tree_query detected; built-in condense is inactive. Remove the separate pi-condense installation and reload to use the built-in version. Existing configuration and archives are preserved.", "warning");
        return;
      }
      runtime = createCondenseRuntime(pi);
    }
    await runtime.start(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    context = undefined;
    unsubscribe();
    runtime?.shutdown(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    ctx.ui.setStatus("metis-condense-cost", undefined);
    runtime?.tree(ctx);
  });
}
