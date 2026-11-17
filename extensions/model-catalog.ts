import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withAccountCatalog } from "../src/model-catalog/provider.ts";

export default async function (pi: ExtensionAPI) {
  // Obtain Pi's stock catalog delegates, including their pi.dev fallback.
  const builtins = await ModelRuntime.create({
    modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
  });
  for (const [id, api] of [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"]] as const) {
    const provider = builtins.getProvider(id);
    if (provider) pi.registerProvider(withAccountCatalog(provider, api));
  }
}
