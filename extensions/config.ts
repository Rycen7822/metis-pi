import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { initializeMetisConfig, metisConfigPath, METIS_CONFIG_GUIDE } from "../src/metis-config.ts";

export default function config(pi: ExtensionAPI): void {
  pi.registerCommand("metis-config", {
    description: "Show the global configuration path; init imports legacy settings and installs the parameter guide",
    async handler(args, ctx) {
      const agentDir = getAgentDir();
      if (!args.trim()) {
        ctx.ui.notify(`Config: ${metisConfigPath(agentDir)}\nGuide: ${join(agentDir, METIS_CONFIG_GUIDE)}\nUse /metis-config init to create/import. Project metis settings are not used.`, "info");
        return;
      }
      if (args.trim() !== "init") { ctx.ui.notify("Usage: /metis-config [init]", "warning"); return; }
      try {
        const result = initializeMetisConfig(agentDir);
        ctx.ui.notify(`${result.created ? "Created" : "Kept existing"} ${result.path}${result.legacy ? " (imported legacy global settings; originals kept)" : ""}\nGuide: ${join(agentDir, METIS_CONFIG_GUIDE)}\nReload/restart Pi to apply startup settings.`, "info");
      } catch (error) { ctx.ui.notify(`Could not initialize metis config: ${(error as Error).message}`, "error"); }
    },
  });
}
