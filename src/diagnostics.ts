// /codex-ui — capability + data diagnostics. States are REAL outcomes
// (installed/applied/disabled/fallback), never "capability exists". Owned
// apart from activate() because it is a pure consumer of every subsystem:
// it reads state and formats lines, and is the one surface that must keep
// working (and keep being honest) when every other feature failed.
//
// Structure: one small builder per report section. Each takes the deps (and
// the few precomputed snapshots the handler already gathered) and returns
// its line(s); the handler only assembles. The report text is asserted
// line-by-line by the pty harness, so builders must stay byte-stable.

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
import type { SelectionCopySystem } from "./selection-copy/index.ts";

/** Mutable things the diagnostics read but activate() owns/reassigns. */
export interface DiagnosticsDeps {
  api: unknown;
  appearanceVersion: string | undefined;
  piVersion: string | undefined;
  getConfig: () => AppearanceConfig;
  chrome: {
    surfaceApplied: boolean; prefixApplied: boolean;
    editorInstalled: boolean; footerInstalled: boolean; headerInstalled: boolean;
    widgetInstalled: boolean; fallbackMessage: boolean;
  };
  hostData: HostData;
  metrics: UiMetrics;
  outcome: InteractionOutcomeTracker;
  ledger: UsageLedger;
  outputSpeed: OutputSpeedTracker;
  gitChanges: GitChangesTracker;
  selectionCopy: SelectionCopySystem | undefined;
  fullscreenMargin: FullscreenMarginSystem | undefined;
  historyWindow: Pick<ReturnType<typeof createHistoryWindowSystem>, "status"> | undefined;
  glyphPresentation: GlyphPresentationSystem | undefined;
  getHandle: () => AdapterHandle | undefined;
  getDecorations: () => DecorationHandle | undefined;
  /** Whether the host injected surface ops (drives the composer fallback reason). */
  hasSurfaceBinding: boolean;
}

// ---------------------------------------------------------------------------
// Small formatting primitives

const fmt = (v: unknown): string => (v === undefined || v === null ? "—" : String(v));
const pct = (x: number): number => Math.round(x * 10) / 10;
const seconds = (ms: number): number => Math.round(ms / 1000);

// ---------------------------------------------------------------------------
// Section builders (each returns one line unless named ...Lines)

const composerLine = (deps: DiagnosticsDeps, config: AppearanceConfig): string => {
  const surface = deps.chrome.surfaceApplied
    ? "applied"
    : config.composer.surface
      ? `fallback (${deps.hasSurfaceBinding ? "color level" : "no surface binding"})`
      : "disabled(config)";
  const prefix = deps.chrome.prefixApplied ? "applied" : "off";
  const metadata = config.composer.metadata && deps.chrome.footerInstalled
    ? "applied"
    : config.composer.metadata ? "fallback (footer unavailable)" : "disabled(config)";
  return `  composer: surface=${surface} prefix=${prefix} metadata=${metadata}`;
};

const workingLine = (config: AppearanceConfig, snap: ReturnType<UiMetrics["snapshot"]>): string => {
  const state = snap.active
    ? `active phase=${snap.phase} elapsed=${seconds(snap.elapsedMs)}s thinking=${seconds(snap.thinkingMs)}s${snap.thinkingOpen ? " (open)" : ""}`
    : "idle";
  const animation = config.working.animation ? `on @${config.working.animationIntervalMs}ms` : "off";
  return `  working: ${state} animation=${animation} interrupt-hint=esc (default fallback; host remap not exposed)`;
};

const modelLine = (deps: DiagnosticsDeps): string => {
  const model = deps.hostData.getModel();
  return `  model: id=${fmt(model?.id)} effort=${fmt(deps.hostData.getThinkingLevel())} provider=${fmt(model?.provider)} window=${fmt(model?.contextWindow)} (live ctx, rev ${deps.hostData.revision})`;
};

const contextLine = (deps: DiagnosticsDeps): string => {
  const usage = deps.hostData.getContextUsage();
  return `  context: tokens=${fmt(usage?.tokens)}/${fmt(usage?.contextWindow)} percent=${fmt(usage?.percent)} — scope=live ctx`;
};

const sessionLine = (deps: DiagnosticsDeps): string => {
  if (!deps.hostData.hasSessionManager) return "  session Σ: unavailable (no sessionManager)";
  const t = deps.ledger.totals();
  return `  session Σ: input=${t.input} output=${t.output} requests=${deps.ledger.confirmedCount} — scope=this session file`;
};

const cacheLine = (deps: DiagnosticsDeps): string => {
  const rate = deps.ledger.cacheRateLast();
  return `  cache(last)=${rate === null ? "—" : `${pct(rate)}%`} — scope=latest confirmed request; ↑=uncached input per Pi normalization`;
};

const speedLine = (deps: DiagnosticsDeps): string => {
  const speed = deps.outputSpeed.snapshot();
  const speedText = formatSpeed(speed?.tokensPerSecond);
  const detail = speedText
    ? `${speedText} (output=${speed!.outputTokens} tokens, window=${(speed!.windowMs / 1000).toFixed(1)}s, scope=${speed!.scope})`
    : "— (no measured response yet)";
  return `  output speed: ${detail} — confirmed usage.output ÷ observed output window; live only when the provider streams cumulative usage`;
};

const interactionLine = (snap: ReturnType<UiMetrics["snapshot"]>): string =>
  `  interaction usage (confirmed): ↑${snap.usage.input} ↓${snap.usage.output} — preview replaces, never sums`;

const outcomeLine = (deps: DiagnosticsDeps): string => {
  const verdict = deps.outcome.frozen ? deps.outcome.freeze() : undefined;
  const detail = verdict
    ? `${verdict.outcome} (evidence=${verdict.evidence}, attempt=${verdict.attempt}, toolErrors=${verdict.toolErrorsObserved}) — ${verdict.reason}`
    : `pending (attempts=${deps.outcome.attemptCount}, toolErrors=${deps.outcome.toolErrorsObserved})`;
  return `  outcome: ${detail}`;
};

const chromeLine = (deps: DiagnosticsDeps): string => {
  const c = deps.chrome;
  const editor = c.editorInstalled ? "applied" : "native";
  const footer = c.footerInstalled ? "applied" : "native/off";
  const header = c.headerInstalled ? "applied" : "native";
  const working = c.widgetInstalled ? "widget" : c.fallbackMessage ? "fallback(message)" : "native";
  return `  chrome: editor=${editor} footer=${footer} header=${header} working=${working}`;
};

const transcriptLine = (deps: DiagnosticsDeps): string => {
  const handle = deps.getHandle();
  const state = handle ? (handle.installed ? "applied" : `failed: ${handle.reason}`) : "not installed";
  return `  transcript: ${state}`;
};

const decorationsLine = (deps: DiagnosticsDeps): string => {
  const decorations = deps.getDecorations();
  const detail = decorations
    ? decorations.features.map((f) => `${f.name}=${f.installed ? "applied" : `failed: ${f.reason}`}`).join(", ")
    : "unavailable (no assistant prototype binding)";
  return `  decorations: ${detail}`;
};

const thinkingLine = (deps: DiagnosticsDeps, config: AppearanceConfig): string => {
  const auto = deps.getDecorations()?.thinkingAutoApplied?.() ?? "n/a";
  return `  thinking: policy=${config.thinking.streaming}/${config.thinking.completed} peekLines=${config.thinking.peekLines} autoVisibility=${auto} (host override-map transitions applied once)`;
};

const fullscreenMarginLine = (deps: DiagnosticsDeps, config: AppearanceConfig): string => {
  if (!deps.fullscreenMargin) {
    return `  fullscreen-margin: ${config.fullscreen.marginX > 0 ? "unavailable (no host bindings)" : "disabled(config)"}`;
  }
  const status = deps.fullscreenMargin.status();
  return `  fullscreen-margin: ${status.installed ? `applied (margin=${config.fullscreen.marginX}, minWidth=${config.fullscreen.minWidth})` : status.reason}`;
};

const glyphsLine = (deps: DiagnosticsDeps): string => {
  const g = deps.glyphPresentation;
  if (!g) return "  glyphs: disabled(config)";
  const status = g.status();
  if (!status.enabled) return "  glyphs: disabled(config)";
  const applied = status.installed ? `applied (${status.reason})` : status.reason;
  const include = deps.getConfig().glyphs.include;
  const includeSuffix = include.length > 0 ? ` include=${include.join(" ")}` : "";
  return `  glyphs: ${applied} marks=${status.glyphs.length} [${status.glyphs.join(" ")}] frames=${status.frames} changed=${status.changed}${includeSuffix}`;
};

const configLine = (config: AppearanceConfig): string => {
  const composer = config.composer.surface
    ? `surface,prefix=${config.composer.promptPrefix},meta=${config.composer.metadata}`
    : "off";
  const workingParts = [
    `elapsed=${config.working.elapsed}`,
    `thought=${config.working.thought}`,
    `tool=${config.working.tool}`,
    `tokens=${config.working.tokens}`,
    `anim=${config.working.animation}@${config.working.animationIntervalMs}ms`,
  ];
  const footerParts = [
    `details=${config.footer.details}`,
    `cache=${config.footer.showCache}`,
    `changes=${config.footer.showChanges}`,
    `speed=${config.footer.showSpeed}`,
  ];
  const writePreview = config.writePreview.enabled ? `${config.writePreview.rows} rows` : "off";
  const summary = config.summary.enabled ? `persist=${config.summary.persist}` : "off";
  return `  config: enabled=${config.enabled}`
    + ` composer=${composer}`
    + ` working=${workingParts.join(",")}`
    + ` footer=${config.footer.enabled ? footerParts.join(",") : "off"}`
    + ` thinking=${config.thinking.streaming}/${config.thinking.completed}`
    + ` writePreview=${writePreview}`
    + ` summary=${summary}`;
};

const resourcesLine = (deps: DiagnosticsDeps): string => {
  const ticker = deps.metrics.tickerAlive ? "alive" : "stopped";
  const gitTimer = deps.gitChanges.running ? `every ${GIT_CHANGES_INTERVAL_MS / 1000}s + activity` : "stopped";
  const widget = deps.chrome.widgetInstalled ? "installed" : "none";
  return `  resources: ticker=${ticker} working-timer=active-only git-timer=${gitTimer} widget=${widget}`;
};

const gitChangesLine = (deps: DiagnosticsDeps): string => {
  const stat = deps.gitChanges.snapshot();
  if (!stat) return "  git-changes: unavailable (no git metadata in cwd, or no successful read yet)";
  const session = deps.gitChanges.session();
  const base = session.rev ? `HEAD ${session.rev.slice(0, 12)}` : "the empty tree (unborn HEAD)";
  return `  git-changes: work tree vs ${base} now +${stat.additions} -${stat.deletions} (${stat.files} files, ${session.observations} reads; staged + unstaged counted once, untracked text files included — reconcile with \`git diff --numstat HEAD\`; ${GIT_CHANGES_INTERVAL_MS / 1000}s poll + ${GIT_CHANGES_DEBOUNCE_MS}ms activity refresh)`;
};

const selectionCopyLines = (deps: DiagnosticsDeps): string[] => {
  if (!deps.selectionCopy) {
    return [`  selection-copy: ${deps.getConfig().selectionCopy.enabled ? "disabled (no host bindings)" : "disabled(config)"}`];
  }
  const d = deps.selectionCopy.diagnostics();
  const t = d.telemetry;
  const m = d.mirrors;
  const serializer = d.serializerInstalled ? (d.live ? "installed+live" : "installed-but-inert") : `not-installed (${d.installBlocker})`;
  const degraded = m.markdownDegraded + m.textDegraded;
  const throttled = m.markdownThrottled + m.textThrottled;
  const lastReason = m.lastDegradedReason ? ` (${m.lastDegradedReason})` : "";
  return [
    `  selection-copy: serializer=${serializer} mirrors(md/txt)=${m.markdownBuilt}/${m.textBuilt} built, ${degraded} degraded, ${throttled} throttled${lastReason} other-wrapper=${d.externalPatch ?? "none"}`,
    `  copy-stats: calls=${t.calls ?? 0} exact=${t.exact} mixed=${t.mixed} native=${t.nativeFallback} empty=${t.emptyDecoration} failed=${t.failed} last=${t.lastMode} chars=${t.lastCharCount} ms=${t.lastDurationMs} cache=${d.cache.hits}/${d.cache.misses}${t.lastReason ? ` lastError=${t.lastReason}` : ""}`,
  ];
};

const historyLine = (deps: DiagnosticsDeps): string =>
  `  history-window: ${JSON.stringify(deps.historyWindow?.status() ?? { installed: false })}`;

const FOOTER_SOURCES_LINE =
  "  footer: model source=live ctx (composer surface) context source=ctx.getContextUsage() session source=UsageLedger(session entries) cwd source=ctx.cwd";

// ---------------------------------------------------------------------------

/** Register the `/codex-ui` command (best-effort: absent host API → no-op). */
export function registerDiagnosticsCommand(deps: DiagnosticsDeps): void {
  (deps.api as { registerCommand?: (name: string, options: unknown) => void } | undefined)?.registerCommand?.("codex-ui", {
    description: "metis-pi capability diagnostics",
    handler: (_args: string, commandCtx: { ui?: { notify?: (text: string) => void } }) => {
      if (!deps.hostData.bound) {
        commandCtx?.ui?.notify?.("metis-pi: no active session");
        return;
      }
      const config = deps.getConfig();
      const snap = deps.metrics.snapshot();
      const appearanceVersion = deps.appearanceVersion ?? "?";
      const piVersion = deps.piVersion ?? "?";
      const lines = [
        `metis-pi ${appearanceVersion} diagnostics (mode=${deps.hostData.mode}, pi=${piVersion}, revision=${deps.hostData.revision}):`,
        composerLine(deps, config),
        workingLine(config, snap),
        FOOTER_SOURCES_LINE,
        modelLine(deps),
        contextLine(deps),
        sessionLine(deps),
        cacheLine(deps),
        speedLine(deps),
        interactionLine(snap),
        outcomeLine(deps),
        chromeLine(deps),
        transcriptLine(deps),
        decorationsLine(deps),
        thinkingLine(deps, config),
        fullscreenMarginLine(deps, config),
        glyphsLine(deps),
        configLine(config),
        resourcesLine(deps),
        gitChangesLine(deps),
        ...selectionCopyLines(deps),
        historyLine(deps),
      ];
      // Return values are ignored by the host; surface via the command ctx.
      commandCtx?.ui?.notify?.(lines.join("\n"));
    },
  });
}
