// /codex-ui — capability + data diagnostics. States are REAL outcomes
// (installed/applied/disabled/fallback), never "capability exists". Owned
// apart from activate() because it is a pure consumer of every subsystem:
// it reads state and formats lines, and is the one surface that must keep
// working (and keep being honest) when every other feature failed.

import type { AdapterHandle } from "./adapter.ts";
import type { AppearanceConfig } from "./config.ts";
import type { FullscreenMarginSystem } from "./chrome/fullscreen-margin.ts";
import type { createHistoryWindowSystem } from "./chrome/history-window.ts";
import type { InteractionOutcomeTracker } from "./interaction-outcome.ts";
import type { GitChangesTracker } from "./git-changes.ts";
import { GIT_CHANGES_DEBOUNCE_MS, GIT_CHANGES_INTERVAL_MS } from "./git-changes.ts";
import type { GlyphPresentationSystem } from "./glyph-presentation.ts";
import type { HostData } from "./host-data.ts";
import type { OutputSpeedTracker } from "./output-speed.ts";
import { formatSpeed } from "./output-speed.ts";
import type { DecorationHandle } from "./transcript-adapter.ts";
import type { UiMetrics } from "./ui-metrics.ts";
import type { UsageLedger } from "./usage-ledger.ts";
import type { QuotaStore } from "./quota/quota-store.ts";
import type { SelectionCopySystem } from "./selection-copy/index.ts";

/** Mutable things the diagnostics read but activate() owns/reassigns. */
export interface DiagnosticsDeps {
  api: unknown;
  appearanceVersion: string | undefined;
  piVersion: string | undefined;
  getConfig: () => AppearanceConfig;
  chrome: {
    surfaceApplied: boolean; prefixApplied: boolean; metaInstalled: boolean;
    editorInstalled: boolean; footerInstalled: boolean; headerInstalled: boolean;
    widgetInstalled: boolean; fallbackMessage: boolean;
  };
  hostData: HostData;
  metrics: UiMetrics;
  outcome: InteractionOutcomeTracker;
  ledger: UsageLedger;
  outputSpeed: OutputSpeedTracker;
  quotaStore: QuotaStore | undefined;
  gitChanges: GitChangesTracker;
  selectionCopy: SelectionCopySystem | undefined;
  fullscreenMargin: FullscreenMarginSystem | undefined;
  historyWindow: Pick<ReturnType<typeof createHistoryWindowSystem>, "status"> | undefined;
  glyphPresentation: GlyphPresentationSystem | undefined;
  getHandle: () => AdapterHandle | undefined;
  getDecorations: () => DecorationHandle | undefined;
  refreshQuota: () => void;
  /** Whether the host injected surface ops (drives the composer fallback reason). */
  hasSurfaceBinding: boolean;
  /** Periodic quota timer state (running only in a live TUI session). */
  quotaTimerRunning: () => boolean;
}

const glyphStatus = (deps: DiagnosticsDeps): string => {
  const g = deps.glyphPresentation;
  if (!g) return "disabled(config)";
  const status = g.status();
  if (!status.enabled) return "disabled(config)";
  const marks = status.glyphs.join(" ");
  const include = deps.getConfig().glyphs.include;
  return `${status.installed ? `applied (${status.reason})` : status.reason} marks=${status.glyphs.length} [${marks}] frames=${status.frames} changed=${status.changed}${include.length > 0 ? ` include=${include.join(" ")}` : ""}`;
};

const selectionCopyLine = (deps: DiagnosticsDeps): string[] => {
  if (!deps.selectionCopy) {
    return [`  selection-copy: ${deps.getConfig().selectionCopy.enabled ? "disabled (no host bindings)" : "disabled(config)"}`];
  }
  const d = deps.selectionCopy.diagnostics();
  const t = d.telemetry;
  const m = d.mirrors;
  return [
    `  selection-copy: serializer=${d.serializerInstalled ? (d.live ? "installed+live" : "installed-but-inert") : `not-installed (${d.installBlocker})`} mirrors(md/txt)=${m.markdownBuilt}/${m.textBuilt} built, ${m.markdownDegraded + m.textDegraded} degraded, ${m.markdownThrottled + m.textThrottled} throttled${m.lastDegradedReason ? ` (${m.lastDegradedReason})` : ""} other-wrapper=${d.externalPatch ?? "none"}`,
    `  copy-stats: calls=${t.calls ?? 0} exact=${t.exact} mixed=${t.mixed} native=${t.nativeFallback} empty=${t.emptyDecoration} failed=${t.failed} last=${t.lastMode} chars=${t.lastCharCount} ms=${t.lastDurationMs} cache=${d.cache.hits}/${d.cache.misses}${t.lastReason ? ` lastError=${t.lastReason}` : ""}`,
  ];
};

/** Register the `/codex-ui` command (best-effort: absent host API → no-op). */
export function registerDiagnosticsCommand(deps: DiagnosticsDeps): void {
  (deps.api as { registerCommand?: (name: string, options: unknown) => void } | undefined)?.registerCommand?.("codex-ui", {
    description: "pi-codex-appearance capability diagnostics",
    handler: (args: string, commandCtx: { ui?: { notify?: (text: string) => void } }) => {
      let text: string;
      if (!deps.hostData.bound) {
        text = "pi-codex-appearance: no active session";
      } else {
        if (typeof args === "string" && args.trim().toLowerCase() === "refresh-quota") {
          deps.refreshQuota();
        }
        const config = deps.getConfig();
        const model = deps.hostData.getModel();
        const level = deps.hostData.getThinkingLevel();
        const usage = deps.hostData.getContextUsage();
        const snap = deps.metrics.snapshot();
        const verdict = deps.outcome.frozen ? deps.outcome.freeze() : undefined;
        const fmt = (v: unknown): string => (v === undefined || v === null ? "—" : String(v));
        const quotaState = deps.quotaStore?.state();
        const speed = deps.outputSpeed.snapshot();
        const speedText = formatSpeed(speed?.tokensPerSecond);
        const speedDetail = speedText
          ? `${speedText} (output=${speed!.outputTokens} tokens, window=${(speed!.windowMs / 1000).toFixed(1)}s, scope=${speed!.scope})`
          : "— (no measured response yet)";
        const quotaAge = deps.quotaStore?.lastSuccessAgeMs(Date.now());
        const quotaDetail = quotaState?.quota
          ? `primary=${quotaState.quota.primary ? `${Math.round(quotaState.quota.primary.remainingPercent * 10) / 10}%${quotaState.quota.primary.windowMinutes ? `/${quotaState.quota.primary.windowMinutes}min` : ""}` : "—"} secondary=${quotaState.quota.secondary ? `${Math.round(quotaState.quota.secondary.remainingPercent * 10) / 10}%` : "—"}`
          : "no snapshot";
        const changeStat = deps.gitChanges.snapshot();
        const changesDetail = changeStat
          ? `+${changeStat.additions} -${changeStat.deletions} (${changeStat.files} files, session Δ vs ${deps.gitChanges.session().rev ?? "index (unborn HEAD)"}${deps.gitChanges.session().baseline ? " + baseline" : ""}, untracked included, ${GIT_CHANGES_INTERVAL_MS / 1000}s poll + ${GIT_CHANGES_DEBOUNCE_MS}ms activity refresh)`
          : "unavailable (no git metadata in cwd)";
        const lines = [
          `pi-codex-appearance ${deps.appearanceVersion ?? "?"} diagnostics (mode=${deps.hostData.mode}, pi=${deps.piVersion ?? "?"}, revision=${deps.hostData.revision}):`,
          `  composer: surface=${deps.chrome.surfaceApplied ? "applied" : config.composer.surface ? `fallback (${deps.hasSurfaceBinding ? "color level" : "no surface binding"})` : "disabled(config)"} prefix=${deps.chrome.prefixApplied ? "applied" : "off"} metadata=${deps.chrome.metaInstalled ? "applied" : config.composer.metadata ? "fallback" : "disabled(config)"}`,
          `  working: ${snap.active ? `active phase=${snap.phase} elapsed=${Math.round(snap.elapsedMs / 1000)}s thinking=${Math.round(snap.thinkingMs / 1000)}s${snap.thinkingOpen ? " (open)" : ""}` : "idle"} animation=${config.working.animation ? `on @${config.working.animationIntervalMs}ms` : "off"} interrupt-hint=esc (default fallback; host remap not exposed)`,
          `  footer: model source=live ctx (composer surface) context source=ctx.getContextUsage() session source=UsageLedger(session entries) cwd source=ctx.cwd`,
          `  model: id=${fmt(model?.id)} effort=${fmt(level)} provider=${fmt(model?.provider)} window=${fmt(model?.contextWindow)} (live ctx, rev ${deps.hostData.revision})`,
          `  context: tokens=${fmt(usage?.tokens)}/${fmt(usage?.contextWindow)} percent=${fmt(usage?.percent)} — scope=live ctx`,
          `  session Σ: ${deps.hostData.hasSessionManager
            ? `input=${deps.ledger.totals().input} output=${deps.ledger.totals().output} requests=${deps.ledger.confirmedCount} — scope=this session file`
            : "unavailable (no sessionManager)"}`,
          `  cache(last)=${deps.ledger.cacheRateLast() === null ? "—" : `${Math.round(deps.ledger.cacheRateLast()! * 10) / 10}%`} — scope=latest confirmed request; ↑=uncached input per Pi normalization`,
          `  output speed: ${speedDetail} — confirmed usage.output ÷ observed output window; live only when the provider streams cumulative usage`,
          `  interaction usage (confirmed): ↑${snap.usage.input} ↓${snap.usage.output} — preview replaces, never sums`,
          `  outcome: ${verdict ? `${verdict.outcome} (evidence=${verdict.evidence}, attempt=${verdict.attempt}, toolErrors=${verdict.toolErrorsObserved}) — ${verdict.reason}` : `pending (attempts=${deps.outcome.attemptCount}, toolErrors=${deps.outcome.toolErrorsObserved})`}`,
          `  codex quota: mode=${config.quota.codex} source=codex-app-server available=${quotaState?.quota ? "yes" : quotaState?.lastErrorClass ? "no" : "unknown"} lastSuccess=${quotaAge === undefined ? "never" : `${Math.round(quotaAge / 1000)}s ago`} ${quotaDetail} stale=${quotaState?.stale ? "yes" : "no"} lastError=${quotaState?.lastErrorClass ?? "—"}`,
          `  chrome: editor=${deps.chrome.editorInstalled ? "applied" : "native"} footer=${deps.chrome.footerInstalled ? "applied" : "native/off"} header=${deps.chrome.headerInstalled ? "applied" : "native"} working=${deps.chrome.widgetInstalled ? "widget" : deps.chrome.fallbackMessage ? "fallback(message)" : "native"}`,
          `  transcript: ${deps.getHandle()?.installed ? "applied" : deps.getHandle() ? `failed: ${deps.getHandle()!.reason}` : "not installed"}`,
          `  decorations: ${deps.getDecorations() ? deps.getDecorations()!.features.map((f) => `${f.name}=${f.installed ? "applied" : `failed: ${f.reason}`}`).join(", ") : "unavailable (no assistant prototype binding)"}`,
          `  thinking: policy=${config.thinking.streaming}/${config.thinking.completed} peekLines=${config.thinking.peekLines} autoVisibility=${deps.getDecorations()?.thinkingAutoApplied?.() ?? "n/a"} (host override-map transitions applied once)`,
          `  fullscreen-margin: ${deps.fullscreenMargin ? (deps.fullscreenMargin.status().installed ? `applied (margin=${config.fullscreen.marginX}, minWidth=${config.fullscreen.minWidth})` : deps.fullscreenMargin.status().reason) : config.fullscreen.marginX > 0 ? "unavailable (no host bindings)" : "disabled(config)"}`,
          `  glyphs: ${glyphStatus(deps)}`,
          `  config: enabled=${config.enabled} composer=${config.composer.surface ? `surface,prefix=${config.composer.promptPrefix},meta=${config.composer.metadata}` : "off"} working=${`elapsed=${config.working.elapsed},thought=${config.working.thought},tool=${config.working.tool},tokens=${config.working.tokens},anim=${config.working.animation}@${config.working.animationIntervalMs}ms`} footer=${config.footer.enabled ? `details=${config.footer.details},cache=${config.footer.showCache},changes=${config.footer.showChanges},quota=${config.footer.showCodexQuota},speed=${config.footer.showSpeed}` : "off"} quota=${config.quota.codex}/${config.quota.refreshSeconds}s thinking=${config.thinking.streaming}/${config.thinking.completed} writePreview=${config.writePreview.enabled ? `${config.writePreview.rows} rows` : "off"} summary=${config.summary.enabled ? `persist=${config.summary.persist}` : "off"}`,
          `  resources: ticker=${deps.metrics.tickerAlive ? "alive" : "stopped"} working-timer=active-only quota-timer=${deps.quotaTimerRunning() ? `every ${config.quota.refreshSeconds}s` : "stopped"} git-timer=${deps.gitChanges.running ? `every ${GIT_CHANGES_INTERVAL_MS / 1000}s + activity` : "stopped"} widget=${deps.chrome.widgetInstalled ? "installed" : "none"}`,
          `  git-changes: ${changesDetail}`,
          ...selectionCopyLine(deps),
          `  history-window: ${JSON.stringify(deps.historyWindow?.status() ?? { installed: false })}`,
        ];
        text = lines.join("\n");
      }
      // Return values are ignored by the host; surface via the command ctx.
      commandCtx?.ui?.notify?.(text);
    },
  });
}
