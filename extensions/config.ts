import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { initializeMetisConfig, metisConfigPath, METIS_CONFIG_GUIDE } from "../src/metis-config.ts";

export default function config(pi: ExtensionAPI): void {
  pi.registerCommand("metis-config", {
    description: "Show global config; init imports legacy settings",
    async handler(args, ctx) {
      const agentDir = getAgentDir(),
        action = args.trim();
      if (!action) {
        ctx.ui.notify(
          "Config: " +
            `${metisConfigPath(agentDir)}` +
            "\nGuide: " +
            `${join(agentDir, METIS_CONFIG_GUIDE)}` +
            "\nUse /metis-config init to create/import global settings. Project metis settings are not used.",
          "info",
        );
        return;
      }
      if (action !== "init") {
        ctx.ui.notify("Usage: /metis-config [init]", "warning");
        return;
      }
      try {
        const result = initializeMetisConfig(agentDir);
        const message =
          `${result.created ? "Created" : "Kept existing"} ${result.path}` +
          `${result.legacy ? " (imported legacy global settings; originals kept)" : ""}` +
          `\nGuide: ${join(agentDir, METIS_CONFIG_GUIDE)}` +
          "\nReload/restart Pi to apply startup settings.";
        ctx.ui.notify(message, "info");
        if (result.notes.length) ctx.ui.notify(result.notes.join("\n"), "warning");
      } catch (error) {
        ctx.ui.notify(`Could not update metis config: ${(error as Error).message}`, "error");
      }
    },
  });
}
