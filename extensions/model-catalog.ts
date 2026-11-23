import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withAccountCatalog } from "../src/model-catalog/provider.ts";
import { withResponsesProgress } from "../src/model-catalog/responses-progress.ts";
import { createResponsesDiagnostics } from "../src/model-catalog/responses-trace.ts";
import { commandChoices } from "../src/command-completions.ts";

export default async function (pi: ExtensionAPI) {
  const diagnostics = createResponsesDiagnostics();
  pi.on("session_start", diagnostics.disable);
  pi.on("session_tree", diagnostics.reset);
  pi.on("session_shutdown", diagnostics.disable);
  pi.registerCommand("responses-stream", {
    description: "Inspect recent OpenAI HTTP Responses stream progress (on/off/status)",
    getArgumentCompletions: commandChoices(["on", "off", "status"]),
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "on") diagnostics.enable();
      else if (action === "off") diagnostics.disable();
      else if (action !== "" && action !== "status") {
        ctx.ui.notify("Usage: /responses-stream [on|off|status]", "warning");
        return;
      }
      ctx.ui.notify(diagnostics.status(), "info");
    },
  });
  // Obtain Pi's stock catalog delegates, including their pi.dev fallback.
  const builtins = await ModelRuntime.create({
    modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
  });
  for (const [id, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]] as const) {
    const provider = builtins.getProvider(id);
    if (!provider) continue;
    const catalog = withAccountCatalog(provider, api);
    pi.registerProvider(api === "openai-responses" ? withResponsesProgress(catalog, undefined, diagnostics.begin) : catalog);
  }
}
