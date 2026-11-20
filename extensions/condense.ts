import { hasMetisHostSDK } from "../src/pi-sdk/host.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCondenseRuntime } from "../src/condense/runtime.ts";

/** Defer registration until Pi can identify an already installed recovery tool. */
export default function condense(pi: ExtensionAPI): void {
  if (!hasMetisHostSDK()) return;
  let runtime: ReturnType<typeof createCondenseRuntime> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (!runtime) {
      if (pi.getAllTools().some((tool) => tool.name === "context_tree_query")) {
        ctx.ui.notify(
          "metis-pi: external context_tree_query detected; built-in condense is inactive. " +
            "Remove the separate pi-condense installation and reload to use the built-in " +
            "version. Existing configuration and archives are preserved.",
          "warning",
        );
        return;
      }
      runtime = createCondenseRuntime(pi);
    }
    await runtime.start(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => runtime?.shutdown(ctx));
  pi.on("session_tree", (_event, ctx) => runtime?.tree(ctx));
}
