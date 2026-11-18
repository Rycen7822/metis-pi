import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { comparePrefixes, observePrefix } from "../src/cache-prefix.ts";

interface Attempt {
  started: number;
  provider: string;
  api: string;
  model: string;
  observation: ReturnType<typeof observePrefix>;
}
interface Reply extends Attempt {
  usage: { cached: number; total: number } | undefined;
}

export default function cachePrefix(pi: ExtensionAPI): void {
  let unsubscribe: (() => void) | undefined;
  let pending: Attempt | undefined;
  let previous: Reply | undefined;
  let latest: Reply | undefined;
  const reset = () => { pending = previous = latest = undefined; };
  const stop = () => { unsubscribe?.(); unsubscribe = undefined; reset(); };
  pi.on("session_start", stop);
  pi.on("session_tree", reset);
  pi.on("session_shutdown", stop);
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant" || !pending) return;
    const attempt = pending;
    pending = undefined;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    if (message.provider !== attempt.provider || message.api !== attempt.api || message.model !== attempt.model) return;
    const { input, cacheRead, cacheWrite } = message.usage;
    const total = input + cacheRead + cacheWrite;
    const usage = [input, cacheRead, cacheWrite].every(n => Number.isSafeInteger(n) && n >= 0) && total > 0
      ? { cached: cacheRead, total } : undefined;
    previous = latest;
    latest = { ...attempt, usage };
  });
  pi.registerCommand("cache-prefix", {
    description: "Opt in to a private, in-memory comparison of prepared request prefixes (on/off/status)",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (!pi.onProviderRequestPrepared) {
        ctx.ui.notify("Cache prefix diagnostics require the Metis Pi SDK with prepared-request observation.", "warning");
        return;
      }
      if (action === "on") {
        unsubscribe ??= pi.onProviderRequestPrepared(({ payload, model, context }) => {
          pending = { started: performance.now(), provider: model.provider, api: model.api, model: model.id,
            observation: observePrefix(payload, model, context) };
        });
        ctx.ui.notify("Cache prefix diagnostics on. It takes two successful requests in this branch to compare.", "info");
      } else if (action === "off") {
        stop();
        ctx.ui.notify("Cache prefix diagnostics off. Captures cleared.", "info");
      } else if (action !== "" && action !== "status") {
        ctx.ui.notify("Usage: /cache-prefix [on|off|status]", "warning");
      } else if (!unsubscribe) {
        ctx.ui.notify("Cache prefix diagnostics off. Use /cache-prefix on before reproducing.", "info");
      } else if (!previous || !latest) {
        ctx.ui.notify(`Cache prefix diagnostics on. Captured ${latest ? 1 : 0} of 2 successful requests.`, "info");
      } else {
        const formatUsage = ({ usage }: Reply) => usage ? `${usage.cached}/${usage.total} cached input tokens` : "usage unavailable";
        const seconds = ((latest.started - previous.started) / 1000).toFixed(1);
        ctx.ui.notify([
          `Cache prefix: last two successful requests (${seconds}s apart)`,
          ...comparePrefixes(previous.observation, latest.observation),
          `Provider usage: ${formatUsage(previous)} → ${formatUsage(latest)}.`,
          "Local payload comparison, not the provider's cache-miss reason.",
        ].join("\n"), "info");
      }
    },
  });
}
