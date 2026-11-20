import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { backgroundRecallEnabled, maintainRecall, refreshRecall } from "./runtime.ts";

const HOUR_MS = 60 * 60 * 1000;

export function wireRecallBackground(pi: ExtensionAPI, getRoot: (ctx: ExtensionContext) => string): void {
  let timer: NodeJS.Timeout | undefined;
  let work: AbortController | undefined;
  let generation = 0;
  let nextSweep = 0;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    work?.abort();
    work = undefined;
    generation++;
    nextSweep = 0;
  };
  const schedule = (ctx: ExtensionContext, delay: number): void => {
    const agentDir = getAgentDir();
    if (work) return;
    if (timer) clearTimeout(timer);
    const current = generation;
    timer = setTimeout(async () => {
      timer = undefined;
      if (current !== generation) return;
      if (!ctx.isIdle()) { schedule(ctx, 5_000); return; }
      const controller = new AbortController();
      work = controller;
      let next = HOUR_MS;
      try {
        const root = getRoot(ctx);
        if (backgroundRecallEnabled(agentDir)) {
          const result = await refreshRecall(agentDir, root, controller.signal);
          if (result.reason === "index_pending") next = 15_000;
        }
        if (Date.now() >= nextSweep && ctx.isIdle() && !controller.signal.aborted) {
          const sweep = await maintainRecall(agentDir, root, controller.signal);
          if (sweep?.reason === "graph_pending" || sweep?.reason === "index_busy") next = 15_000;
          else nextSweep = Date.now() + HOUR_MS;
        }
      } catch {
        // No session directory or worker yet. Foreground hybrid can report the actual error.
      } finally {
        if (current === generation) {
          work = undefined;
          schedule(ctx, next);
        }
      }
    }, delay);
    timer.unref();
  };

  pi.on("session_start", (_event, ctx) => { stop(); schedule(ctx, 2_000); });
  pi.on("agent_end", (_event, ctx) => schedule(ctx, 2_000));
  pi.on("session_shutdown", stop);
}
