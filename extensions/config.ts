import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { initializeMetisConfig, migrateMetisConfig, metisConfigPath, METIS_CONFIG_GUIDE } from "../src/metis-config.ts";

export default function config(pi: ExtensionAPI): void {
  pi.registerCommand("metis-config", {
    description: "Show global config; init imports legacy settings; migrate backs up and upgrades an existing TOML",
    async handler(args, ctx) {
      const agentDir = getAgentDir(),
        action = args.trim();
      if (!action) {
        ctx.ui.notify(
          "Config: " +
            `${metisConfigPath(agentDir)}` +
            "\nGuide: " +
            `${join(agentDir, METIS_CONFIG_GUIDE)}` +
            "\nUse /metis-config init to create/import, or migrate to back up and upgrade " +
            "existing TOML. Project metis settings are not used.",
          "info",
        );
        return;
      }
      if (!["init", "migrate"].includes(action)) {
        ctx.ui.notify("Usage: /metis-config [init|migrate]", "warning");
        return;
      }
      try {
        const result = action === "migrate" ? migrateMetisConfig(agentDir) : initializeMetisConfig(agentDir);
        const message =
          "backup" in result
            ? "Migrated " +
              `${result.path}` +
              "\nBackup: " +
              `${result.backup}` +
              "\nGuide refreshed; originals kept. Reload Pi. Drain and normally stop the " +
              "subagent daemon before reconnecting."
            : `${result.created ? "Created" : "Kept existing"}` +
              " " +
              `${result.path}` +
              `${result.legacy ? " (imported legacy global settings; originals kept)" : ""}` +
              "\nGuide: " +
              `${join(agentDir, METIS_CONFIG_GUIDE)}` +
              "\nReload/restart Pi to apply startup settings.";
        ctx.ui.notify(message, "info");
        if (result.notes.length) ctx.ui.notify(result.notes.join("\n"), "warning");
      } catch (error) {
        ctx.ui.notify(`Could not update metis config: ${(error as Error).message}`, "error");
      }
    },
  });
}
