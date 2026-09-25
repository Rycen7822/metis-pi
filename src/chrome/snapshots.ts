// Snapshot builders for the chrome widgets: one revision of display data per
// render, assembled from the data bridge (hostData), the session ledger, the
// interaction metrics, the output-speed tracker and the git-changes tracker.
// Owned here so activate() stays wiring-only; every builder
// is a pure read of the deps below (config via getConfig: it is reassigned on
// config reload).

import type { AppearanceConfig } from "../config.ts";
import type { GitChangesTracker } from "../git-changes.ts";
import type { HostData } from "../host-data.ts";
import type { OutputSpeedTracker } from "../output-speed.ts";
import type { UiMetrics } from "../ui-metrics.ts";
import type { UsageLedger } from "../usage-ledger.ts";
import type { FooterShow, FooterSnapshot } from "./footer.ts";
import type { WorkingAnimation, WorkingShow, WorkingSnapshotWithUsage } from "./working.ts";

export interface SnapshotSourceDeps {
  getConfig: () => AppearanceConfig;
  hostData: HostData;
  ledger: UsageLedger;
  metrics: UiMetrics;
  outputSpeed: OutputSpeedTracker;
  gitChanges: GitChangesTracker;
}

export interface SnapshotSource {
  /** Config-gated footer segments (read fresh per render). */
  footerShow(): FooterShow;
  /** Config-gated working segments. */
  workingShow(): WorkingShow;
  /** Working animation knobs. */
  workingAnimation(): WorkingAnimation;
  /** Interaction-scoped working snapshot (active phase, tools, uncached I/O). */
  getWorkingSnapshot(): WorkingSnapshotWithUsage;
  /** Footer snapshot: identity, cwd, context, session totals, cache, speed, changes. */
  getFooterSnapshot(): FooterSnapshot;
}

export function createSnapshotSource(deps: SnapshotSourceDeps): SnapshotSource {
  const { getConfig, hostData, ledger, metrics, outputSpeed, gitChanges } = deps;
  const footerShow = (): FooterShow => ({
    metadata: getConfig().composer.metadata,
    details: getConfig().footer.details,
    showCache: getConfig().footer.showCache,
    showChanges: getConfig().footer.showChanges,
    showSpeed: getConfig().footer.showSpeed,
  });
  const workingShow = (): WorkingShow => ({
    elapsed: getConfig().working.elapsed,
    thought: getConfig().working.thought,
    tool: getConfig().working.tool,
    tokens: getConfig().working.tokens,
  });
  const workingAnimation = (): WorkingAnimation => ({
    enabled: getConfig().working.animation,
    intervalMs: getConfig().working.animationIntervalMs,
  });
  const getWorkingSnapshot = (): WorkingSnapshotWithUsage => {
    const s = metrics.snapshot();
    return {
      active: s.active,
      phase: s.phase,
      elapsedMs: s.elapsedMs,
      thinkingMs: s.thinkingMs,
      thinkingOpen: s.thinkingOpen,
      tools: s.tools,
      usage: { input: s.usage.input, output: s.usage.output },
    };
  };
  const getFooterSnapshot = (): FooterSnapshot => {
    return {
      model: hostData.getModel(),
      thinkingLevel: hostData.getThinkingLevel(),
      contextUsage: hostData.getContextUsage(),
      cwd: hostData.getCwd(),
      session: hostData.hasSessionManager ? ledger.totals() : undefined,
      cacheLastPct: ledger.cacheRateLast(),
      speed: outputSpeed.snapshot(),
      changes: gitChanges.snapshot(),
      revision: hostData.revision,
    };
  };
  return { footerShow, workingShow, workingAnimation, getWorkingSnapshot, getFooterSnapshot };
}
