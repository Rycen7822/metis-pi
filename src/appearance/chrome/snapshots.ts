// Snapshot builders for the chrome widgets: one revision of display data per
// render, assembled from the data bridge (hostData), the session ledger, the
// interaction metrics, the output-speed tracker and the git-changes tracker.
// Owned here so activate() stays wiring-only; every builder
// is a pure read of the deps below.

import type { AppearanceConfig } from "../config.ts";
import type { GitChangesTracker } from "../git-changes.ts";
import type { HostData } from "../host-data.ts";
import type { OutputSpeedTracker } from "../activity/output-speed.ts";
import type { UiMetrics } from "../activity/ui-metrics.ts";
import type { UsageLedger } from "../activity/usage-ledger.ts";
import type { FooterShow, FooterSnapshot } from "./footer.ts";
import type { WorkingAnimation, WorkingShow, WorkingSnapshotWithUsage } from "./working.ts";

export interface SnapshotSourceDeps {
  config: AppearanceConfig;
  hostData: HostData;
  ledger: UsageLedger;
  metrics: UiMetrics;
  outputSpeed: OutputSpeedTracker;
  gitChanges: GitChangesTracker;
}

export interface SnapshotSource {
  footerShow: FooterShow;
  workingShow(): WorkingShow;
  workingAnimation(): WorkingAnimation;
  /** Interaction-scoped working snapshot (active phase, tools, uncached I/O). */
  getWorkingSnapshot(): WorkingSnapshotWithUsage;
  getFooterSnapshot(): FooterSnapshot;
}

export function createSnapshotSource(deps: SnapshotSourceDeps): SnapshotSource {
  const { config, hostData, ledger, metrics, outputSpeed, gitChanges } = deps;
  const footerShow = { ...config.footer, metadata: config.composer.metadata };
  const animation = { enabled: config.working.animation, intervalMs: config.working.animationIntervalMs };
  const getFooterSnapshot = (): FooterSnapshot => {
    return {
      model: hostData.getModel(),
      thinkingLevel: hostData.getThinkingLevel(),
      contextUsage: footerShow.metadata ? hostData.getContextUsage() : undefined,
      cwd: hostData.getCwd(),
      session: hostData.hasSessionManager ? ledger.totals() : undefined,
      cacheLastPct: ledger.cacheRateLast(),
      speed: outputSpeed.snapshot(),
      changes: gitChanges.snapshot(),
      revision: hostData.revision,
    };
  };
  return {
    footerShow, getFooterSnapshot, getWorkingSnapshot: () => metrics.snapshot(),
    workingShow: () => config.working, workingAnimation: () => animation,
  };
}
