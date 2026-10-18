import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActionTool } from "../deferred-action-tool.ts";
import type { HealthCheck } from "./native/binding/api.ts";
import { createSearchActions } from "./tools/actions.ts";
import { scanOptOutReason } from "./native/paths.ts";
import { loadConfig } from "./config.ts";
import { createMentionWrapper } from "./ui/mentions.ts";
import { SearchRuntime } from "./session.ts";

export const SEARCH_TOOL_NAME = "neural_search";

function databaseState(health: HealthCheck["frecency"]): string {
  if (health.error) return `health-check error (${health.error})`;
  if (!health.initialized) return "disabled";
  return health.dbHealthcheck?.healthy === false ? "not healthy (maintenance/degraded)" : "active";
}

export default function createNeuralSearch(pi: ExtensionAPI, isAvailable?: () => boolean): ReadonlyMap<string, ActionTool> | undefined {
  const config = loadConfig();
  if (!config.enabled) return;
  const runtime = new SearchRuntime(config);

  // With an ownership check, defer auxiliary setup until the registry is bound.
  let active = !isAvailable;
  let sessionEpoch = 0;
  const isActive = () => {
    if (active && isAvailable && !isAvailable()) {
      active = false;
      runtime.shutdown();
    }
    return active;
  };

  const registerCommand = () => pi.registerCommand("neural-search", {
    description: "Local search index: /neural-search health | rescan",
    handler: async (args, ctx) => {
      if (!isActive()) {
        ctx.ui.notify("Neural search is inactive in this session.", "warning");
        return;
      }
      const action = args.trim() || "health";
      if (action !== "health" && action !== "rescan") {
        ctx.ui.notify("Usage: /neural-search health | rescan", "warning");
        return;
      }
      const signal = ctx.signal;
      try {
        signal?.throwIfAborted();
        const scope = runtime.bind(ctx);
        const finder = await runtime.ensureMain(scope, signal);
        if (!isActive()) return;
        runtime.assertCurrent(scope);
        if (action === "rescan") {
          const result = finder.scanFiles();
          if (!result.ok) throw new Error(result.error);
          runtime.cursors.clear();
          ctx.ui.notify("Neural-search rescan triggered; existing pagination cursors are now stale.", "info");
          return;
        }
        const health = finder.healthCheck(scope.cwd);
        if (!health.ok) throw new Error(health.error);
        const value = health.value;
        const lines = [
          `Neural search (FFF v${value.version})`,
          `Root: ${scope.cwd}`,
          `Git: ${value.git.repositoryFound ? `yes (${value.git.workdir ?? "unknown"})` : "no"}`,
          `Index: ${value.filePicker.error ? `error (${value.filePicker.error})` : value.filePicker.initialized ? `${value.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
          `Frecency: ${databaseState(value.frecency)}`,
          `Query history: ${databaseState(value.queryTracker)}`,
        ];
        const progress = finder.getScanProgress();
        if (progress.ok) {
          lines.push(`Index ready: ${progress.value.isReady ? "yes" : "no"}; scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`);
          if (progress.value.gitStatusError) lines.push(`Index Git metadata error: ${progress.value.gitStatusError}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        if (signal?.aborted && error === signal.reason) return;
        ctx.ui.notify(`Neural search: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  if (!isAvailable) registerCommand();
  pi.on("session_start", (_event, ctx) => {
    const epoch = ++sessionEpoch;
    active = !isAvailable || isAvailable();
    if (!active) { runtime.shutdown(); return; }
    runtime.start(ctx);
    registerCommand();
    const refusal = scanOptOutReason(ctx.cwd, config);
    if (refusal) ctx.ui.notify(refusal, "warning");
    if (config.mentions && ctx.mode === "tui") ctx.ui.addAutocompleteProvider(
      createMentionWrapper(runtime, () => epoch === sessionEpoch && isActive()),
    );
  });
  pi.on("before_agent_start", (_event, ctx) => { if (isActive()) runtime.bind(ctx); });
  pi.on("session_shutdown", () => { active = false; runtime.shutdown(); });
  return createSearchActions(runtime, SEARCH_TOOL_NAME);
}
