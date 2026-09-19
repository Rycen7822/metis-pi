import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { installTranscriptDecorations, type DecorationHandle, type ThinkingPolicy } from "./transcript-adapter.ts";
import { TranscriptState, type TranscriptEvent } from "./transcript-state.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories, type WritePreviewInput } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";
import { UiMetrics, formatDuration, formatTokensCompact } from "./ui-metrics.ts";
import { OutputSpeedTracker, formatSpeed } from "./output-speed.ts";
import { TurnSummary, formatSummaryLine } from "./turn-summary.ts";
import { probeHost, type HostFacts } from "./host-compat.ts";
import { loadConfig, type AppearanceConfig } from "./config.ts";
import { HostData, type HostContextLike } from "./host-data.ts";
import { UsageLedger, sanitizeUsage, type RawUsage } from "./usage-ledger.ts";
import { InteractionOutcomeTracker } from "./interaction-outcome.ts";
import { createGitChangesTracker, GIT_CHANGES_DEBOUNCE_MS, GIT_CHANGES_INTERVAL_MS } from "./git-changes.ts";
import { createGlyphPresentation } from "./glyph-presentation.ts";
import { diffSignFg } from "./diff.ts";
import type { SegmentTone } from "./segments.ts";
import type { ThinkingView, ThinkingViewControl } from "./thinking-view.ts";
import { WORKING_WIDGET_KEY, type WorkingShow, type WorkingAnimation, type WorkingComponent } from "./chrome/working.ts";
import { COMPOSER_META_WIDGET_KEY, type ComposerMetaSnapshot } from "./chrome/composer-metadata.ts";
import type { FooterShow, FooterSnapshot } from "./chrome/footer.ts";
import type { CodexSurfaceOps } from "./chrome/editor.ts";
import { QuotaStore } from "./quota/quota-store.ts";
import { createSelectionCopySystem, type SelectionCopyHost, type SelectionCopySystem } from "./selection-copy/index.ts";
import { createFullscreenMargin, type FullscreenMarginHost, type FullscreenMarginSystem } from "./chrome/fullscreen-margin.ts";
import { createHistoryWindowSystem, type HistoryWindowHost } from "./chrome/history-window.ts";
import type { CodexQuotaSnapshot } from "./quota/types.ts";

export interface AppearanceAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    hasUI: boolean; ui: { notify(text: string, level: "warning"): void };
  }) => void): void;
  on(event: "tool_execution_start", handler: (event: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }, context: { cwd: string }) => void): void;
  on(event: "tool_execution_end", handler: (event: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }, context: { cwd: string }) => void): void;
  on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  on(event: "agent_start" | "agent_settled" | "agent_end", handler: (event: { type: string }, context: unknown) => void): void;
  on(event: "model_select" | "thinking_level_select" | "session_tree" | "session_compact" | "session_compact_failed" | "ui_prompt_start" | "ui_prompt_end" | "input", handler: (event: { type: string; level?: unknown }) => void): void;
  getAllTools(): readonly unknown[];
}
export interface Bindings {
  prototype: object;
  makeText: TextFactory;
  expandHint(): string;
  highlight?: Highlight;
  makeDiff?: DiffFactory;
  makeShell?: ShellFactories;
  /** Pipeline color capability resolved from the live terminal (host-provided). */
  colorLevel?: ColorLevel;
  /** Real terminal layout ops (wrap/width) for fallback text paths. */
  layoutOps?: import("./tool-names.ts").DiffLayoutOps;
  /** Pi AssistantMessageComponent prototype (separator decoration target). */
  assistantPrototype?: object;
  /** Build a width-aware separator component (host TUI Text). */
  makeSeparator?: () => unknown;
  /** Build a 1-row spacer component (host TUI Spacer). */
  makeSpacer?: () => unknown;
  /** Wrap a thinking display node with our rail (host TUI primitives). */
  makeRail?: (child: unknown) => unknown;
  /**
   * Build the collapsed-run summary label ("Thought for 13s") as a
   * display-only host Text (index.ts owns host styling).
   */
  makeThoughtSummary?: (input: { durationMs?: number; runIndex: number; ended: boolean; paddingX: number }) => unknown;
  /** Structural guard for the host's collapsed-label Text (real class check). */
  isCollapsedLabel?: (node: unknown) => boolean;
  /** Wrap a thinking body in the peek window (newest N rows, wheel-scrollable). */
  makePeek?: (input: {
    inner: unknown;
    control: ThinkingViewControl;
    windowLines: number;
    onScroll: () => void;
  }) => unknown;
  /** Wrap a thinking body/label so left clicks drive the run's view state. */
  makeClickable?: (input: {
    inner: unknown;
    control: ThinkingViewControl;
    fallback: ThinkingView;
    apply: (next: ThinkingView) => void;
  }) => unknown;
  /** Detect an external owner that already renders thinking rails. */
  externalRailOwner?: () => boolean;
  /** Build the live write call component (header + stage + preview body). */
  makeWriteCall?: (input: WritePreviewInput & { headerText: string }) => import("./tool-names.ts").Component | undefined;

  /** Host CustomEditor class for the chrome editor factory (index.ts only). */
  editorHost?: { CustomEditor: unknown };
  /** Gray composer surface painters (index.ts, from real Tui helpers). */
  surface?: CodexSurfaceOps;
  /** The full ExtensionAPI object (for appendEntry / registerEntryRenderer / registerCommand). */
  api?: unknown;
  /** Real package version of this extension (read from package.json at entry). */
  appearanceVersion?: string;
  /** Real host version (Pi.VERSION at entry). */
  piVersion?: string;
  /** Read the agent config dir (host getAgentDir or ~/.pi/agent). */
  getAgentDir?: () => string | undefined;
  /** Read a file (config loading; injected to keep tests filesystem-free). */
  readFile?: (path: string) => string | undefined;
  /** Injectable Codex quota query (tests; default: real codex app-server). */
  codexQuotaQuery?: (options: { timeoutMs: number; clientVersion?: string }) => Promise<CodexQuotaSnapshot>;
  /** Host TUI classes/primitives for the selection-copy system (index.ts). */
  selectionCopyHost?: SelectionCopyHost;
  /** Host TUI HStack/Spacer constructors for the fullscreen margin (index.ts). */
  marginHost?: FullscreenMarginHost;
  historyWindowHost?: HistoryWindowHost;
}

/** Bounded store for completed write diffs (entry + total budget). */
const MAX_WRITE_CHANGES = 64;
const SUMMARY_STATUS_KEY = "pi-codex-appearance:summary";

/** Extract image-block count from a tool result WITHOUT copying payloads. */
function countImageBlocks(result: unknown): number {
  try {
    const content = (result as Record<string, unknown> | null)?.content;
    if (!Array.isArray(content)) return 0;
    return content.filter((block) => (block as Record<string, unknown>)?.type === "image").length;
  } catch {
    return 0;
  }
}

/** Normalize a host message into the state machine's read-only shape. */
function toStateMessage(message: unknown): TranscriptEvent["message"] {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (!role) return undefined;
  const content = Array.isArray(record.content)
    ? (record.content as unknown[]).map((block) => {
        const b = (block ?? {}) as Record<string, unknown>;
        return { type: String(b.type ?? ""), text: typeof b.text === "string" ? b.text : undefined, thinking: typeof b.thinking === "string" ? b.thinking : undefined };
      })
    : [];
  return {
    role,
    content,
    stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
  };
}

/** Usage key shared by the interaction metrics and the session ledger:
 * `${provider}:${responseId}` (namespaced — responseIds can collide across
 * providers), `m-${timestamp}` when the host gives no response id. */
function usageKeyOf(record: Record<string, unknown>): { key: string; identified: boolean } {
  const responseId = typeof record.responseId === "string" && record.responseId ? record.responseId : undefined;
  if (responseId) return { key: `${String(record.provider)}:${responseId}`, identified: true };
  const timestamp = record.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return { key: `m-${timestamp}`, identified: true };
  return { key: `u-${Math.random().toString(36).slice(2)}`, identified: false };
}

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let chromeEnabled = false;
  let handle: AdapterHandle | undefined;
  let decorations: DecorationHandle | undefined;
  const transcript = new TranscriptState();
  const tracker = new WriteDiffTracker();
  const session = {
    colorLevel: bindings.colorLevel ?? detectColorLevel(),
    writeChanges: new Map<string, WriteDiff>(),
    transcript,
  };

  // Data bridge + ledgers (all display data flows through these).
  const hostData = new HostData();
  const ledger = new UsageLedger();
  const outcome = new InteractionOutcomeTracker();
  // Output speed: one measured window per assistant response (see
  // output-speed.ts for the exact scope of the number).
  const outputSpeed = new OutputSpeedTracker({ now: () => performance.now() });
  let config: AppearanceConfig = loadConfig(bindings.getAgentDir?.(), bindings.readFile).config;

  // Quota store: read-only Codex subscription quota (auxiliary UI data — a
  // failure here must never touch agent outcomes).
  const quotaStore = config.quota.codex !== "off"
    ? new QuotaStore({ timeoutMs: config.quota.timeoutMs, clientVersion: bindings.appearanceVersion, query: bindings.codexQuotaQuery })
    : undefined;
  let quotaTimer: ReturnType<typeof setInterval> | undefined;
  let lastQuotaRefreshAt = 0;

  // Chrome install state. `generation` invalidates late async installs:
  // a preload resolving after shutdown/new-session must not touch the new UI.
  const chrome = {
    generation: 0,
    editorFactory: undefined as object | undefined,
    editorInstalled: false,
    surfaceApplied: false,
    prefixApplied: false,
    footerInstalled: false,
    headerInstalled: false,
    metaInstalled: false,
    widgetInstalled: false,
    widgetFactory: undefined as unknown,
    workingComponent: undefined as WorkingComponent | undefined,
    nativeLoaderHidden: false,
    fallbackMessage: false,
    tui: undefined as { requestRender?: () => void } | undefined,
  };
  const selectionCopy: SelectionCopySystem | undefined = bindings.selectionCopyHost && config.enabled && config.selectionCopy.enabled
    ? createSelectionCopySystem(bindings.selectionCopyHost, undefined)
    : undefined;
  if (selectionCopy) {
    const wrap = selectionCopy.wrapPrototypes();
    if (!wrap.installed) {
      // Wrapping failed: keep native copy semantics, no half-applied state.
      process.stderr.write(`pi-codex-appearance: selection-copy prototypes unavailable (${wrap.details})\n`);
    }
  }
  // Fullscreen gutters: install retries ride captureTui / agent_start — the
  // captured renderer may still be the main screen at first.
  const fullscreenMargin: FullscreenMarginSystem | undefined = bindings.marginHost && config.enabled && config.fullscreen.marginX > 0
    ? createFullscreenMargin(bindings.marginHost, { margin: config.fullscreen.marginX, minWidth: config.fullscreen.minWidth })
    : undefined;
  const historyWindow = bindings.historyWindowHost && config.enabled ? createHistoryWindowSystem(bindings.historyWindowHost) : undefined;
  // Glyph presentation: the last mile of the frame (terminal writes only), so
  // emoji-presentation marks like ✔/✖ are drawn by the monospace font instead
  // of an emoji font that paints over the next character (see
  // glyph-presentation.ts). Installed from captureTui with the same retry logic.
  const glyphPresentation = config.enabled ? createGlyphPresentation({ enabled: config.glyphs.textPresentation, include: config.glyphs.include }) : undefined;
  type ChromeMods = typeof import("./chrome/editor.ts") & typeof import("./chrome/footer.ts") & typeof import("./chrome/header.ts") & typeof import("./chrome/working.ts") & typeof import("./chrome/composer-metadata.ts");
  let chromeMods: Promise<ChromeMods | undefined> | undefined;
  const preloadChrome = (): Promise<ChromeMods | undefined> => {
    chromeMods ??= Promise.all([
      import("./chrome/editor.ts"),
      import("./chrome/footer.ts"),
      import("./chrome/header.ts"),
      import("./chrome/working.ts"),
      import("./chrome/composer-metadata.ts"),
    ]).then(([editor, footer, header, working, meta]) => ({ ...editor, ...footer, ...header, ...working, ...meta }))
      .catch(() => undefined);
    return chromeMods;
  };
  // Start the preload immediately so session_start rarely waits.
  void preloadChrome();

  const requestRender = (): void => {
    try {
      chrome.tui?.requestRender?.();
    } catch { /* render happens on the next host cycle */ }
  };

  // Session change counts for the footer: display-only git reads on a 2s poll
  // plus activity-driven refreshes (agent ticks, tool work), armed only while a
  // TUI session is live (see git-changes.ts).
  const gitChanges = createGitChangesTracker({
    getCwd: () => hostData.getCwd(),
    onUpdate: requestRender,
  });

  // The factory-time tui is the only reliable requestRender source. Prototype
  // installs retry on every capture and agent activity — the captured
  // renderer may still be the main screen at first (owner-symbol idempotent).
  let serializerHost: unknown = undefined;
  const captureTui = (tui: unknown): void => {
    if (!tui || typeof tui !== "object") return;
    if (!chrome.tui) {
      const rr = (tui as { requestRender?: unknown }).requestRender;
      if (typeof rr === "function") chrome.tui = tui as { requestRender?: () => void };
    }
    serializerHost ??= tui;
    if (selectionCopy) selectionCopy.installOnTui(serializerHost);
    fullscreenMargin?.installOnTui(tui);
    glyphPresentation?.installOnTui(tui);
    historyWindow?.installOnTui(tui);
  };

  const footerShow = (): FooterShow => ({
    details: config.footer.details,
    showCache: config.footer.showCache,
    showChanges: config.footer.showChanges,
    showCodexQuota: config.footer.showCodexQuota,
    showSpeed: config.footer.showSpeed,
  });
  const workingShow = (): WorkingShow => ({
    elapsed: config.working.elapsed,
    thought: config.working.thought,
    tool: config.working.tool,
    tokens: config.working.tokens,
  });
  const workingAnimation = (): WorkingAnimation => ({
    enabled: config.working.animation,
    intervalMs: config.working.animationIntervalMs,
  });
  const getWorkingSnapshot = () => {
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
  const getComposerMetaSnapshot = (): ComposerMetaSnapshot => ({
    model: hostData.getModel(),
    thinkingLevel: hostData.getThinkingLevel(),
    contextUsage: hostData.getContextUsage(),
    revision: hostData.revision,
  });
  const getFooterSnapshot = (): FooterSnapshot => {
    const quota = quotaStore?.state();
    return {
      cwd: hostData.getCwd(),
      session: hostData.hasSessionManager ? ledger.totals() : undefined,
      cacheLastPct: ledger.cacheRateLast(),
      quota: quota?.quota,
      quotaStale: quota?.stale ?? false,
      speed: outputSpeed.snapshot(),
      changes: gitChanges.snapshot(),
      revision: hostData.revision,
    };
  };

  const metrics = new UiMetrics(
    { now: () => performance.now(), wall: () => Date.now() },
    {
      onTick: (snapshot) => {
        if (!chromeEnabled) return;
        // Activity signal for the footer's change counts: refresh while the
        // agent works, so an edit lands in the footer in ~debounce time
        // instead of waiting for the next poll.
        gitChanges.touch();
        if (chrome.widgetInstalled) {
          // The widget component reads the snapshot at render; a 1s tick just
          // asks the host for a frame. No per-token reinstalls.
          requestRender();
          return;
        }
        if (chrome.fallbackMessage && config.working.elapsed) {
          const ui = hostData.ui as { setWorkingMessage?: (message?: string) => void };
          const label = snapshot.phase === "writing" ? "Writing" : snapshot.phase === "waiting-for-input" ? "Waiting for input" : "Working";
          ui.setWorkingMessage?.(`${label} (${formatDuration(snapshot.elapsedMs)})`);
        }
      },
      onSettled: (snapshot) => {
        if (!chromeEnabled) return;
        gitChanges.touch();
        // Hide the active widget and stop its animation timer — idle leaves
        // zero timers.
        chrome.workingComponent?.stopAnimation();
        setWidgetVisible(false);
        const ui = hostData.ui as { setWorkingMessage?: (message?: string) => void };
        ui.setWorkingMessage?.();
        if (!config.summary.enabled) return;
        const verdict = outcome.freeze();
        if (config.summary.persist) {
          turnSummary.record(snapshot, verdict);
        } else {
          // Transient public-UI path (no third transcript patch): the settled
          // line lives in the footer status row until the next interaction.
          const line = formatSummaryLine(snapshot, verdict.outcome);
          const u = hostData.ui as { setStatus?: (key: string, text: string | undefined) => void };
          try {
            u.setStatus?.(SUMMARY_STATUS_KEY, line);
          } catch { /* status slot is best-effort */ }
        }
      },
    },
  );
  const turnSummary = new TurnSummary({
    appendEntry: (type, data) => {
      (bindings.api as { appendEntry?: (t: string, d?: unknown) => void } | undefined)?.appendEntry?.(type, data);
    },
    registerEntryRenderer: (type, renderer) => {
      (bindings.api as { registerEntryRenderer?: (t: string, r: unknown) => void } | undefined)?.registerEntryRenderer?.(type, renderer);
    },
    persist: config.summary.persist,
    wall: () => Date.now(),
  });

  /** Quota refresh policy: session_start → once; agent_settled → when the
   * last refresh is older than 30s; periodic ≤ refreshSeconds while TUI.
   * `refresh` coalesces concurrent calls; failures keep the last-good state. */
  const maybeRefreshQuota = (force = false): void => {
    if (!quotaStore || !chromeEnabled) return;
    const now = Date.now();
    if (!force && now - lastQuotaRefreshAt < 5_000) return; // coalesce bursts
    lastQuotaRefreshAt = now;
    void quotaStore.refresh();
  };
  const startQuotaTimer = (): void => {
    if (!quotaStore || quotaTimer) return;
    quotaTimer = setInterval(() => maybeRefreshQuota(), Math.max(30, config.quota.refreshSeconds) * 1000);
    (quotaTimer as unknown as { unref?: () => void }).unref?.();
  };
  const stopQuotaTimer = (): void => {
    if (quotaTimer) {
      clearInterval(quotaTimer);
      quotaTimer = undefined;
    }
  };

  /** Show/hide the above-editor Working widget (undefined = hide). */
  function setWidgetVisible(visible: boolean): void {
    const ui = hostData.ui as { setWidget?: (key: string, content: unknown, options?: unknown) => void };
    if (typeof ui.setWidget !== "function") return;
    try {
      if (visible && chrome.widgetInstalled && chrome.widgetFactory) {
        ui.setWidget(WORKING_WIDGET_KEY, chrome.widgetFactory, { placement: "aboveEditor" });
      } else if (!visible) {
        ui.setWidget(WORKING_WIDGET_KEY, undefined);
      }
    } catch { /* widget slot is best-effort */ }
  }

  pi.on("session_start", (_event, ctx) => {
    const full = ctx as unknown as HostContextLike & { hasUI?: boolean; ui?: Record<string, unknown> };
    chrome.generation += 1;
    hostData.bind(full);
    ledger.rebuild(hostData.getSessionEntries());
    outcome.reset();
    quotaStore?.reset();
    lastQuotaRefreshAt = 0;
    const facts: HostFacts = probeHost({ ui: hostData.ui as never, mode: hostData.mode, hasUI: hostData.hasUI });
    enabled = facts.isTui || full.hasUI === true;
    // Chrome/metrics/summary side effects only in the REAL TUI process and
    // only while enabled — print/json/rpc never get timers or ANSI.
    chromeEnabled = facts.isTui && config.enabled !== false;
    if (chromeEnabled) {
      void installChrome(facts, chrome.generation);
      startQuotaTimer();
      maybeRefreshQuota(true);
      gitChanges.start();
    }
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff, bindings.makeShell, bindings.makeWriteCall, session, bindings.layoutOps),
    });
    if (!handle.installed) ctx.ui.notify(`pi-codex-appearance: ${handle.reason}. Compact transcript was not installed.`, "warning");
    // Scoped transcript decorations (member spacing + assistant separator +
    // thinking rail). Failures are reported PER FEATURE; per-member rows,
    // native text and the output dimming keep working regardless.
    if (bindings.assistantPrototype && bindings.makeSeparator) {
      const thinkingPolicy = (): ThinkingPolicy => ({
        streaming: config.thinking.streaming,
        completed: config.thinking.completed,
        peekLines: config.thinking.peekLines,
      });
      decorations = installTranscriptDecorations({
        state: transcript,
        toolPrototype: bindings.prototype,
        assistantPrototype: bindings.assistantPrototype,
        makeSeparator: bindings.makeSeparator,
        makeSpacer: bindings.makeSpacer ?? (() => undefined),
        makeRail: bindings.makeRail,
        makePeek: bindings.makePeek,
        makeClickable: bindings.makeClickable,
        externalRailOwner: bindings.externalRailOwner,
        thinkingPolicy,
        makeThoughtSummary: bindings.makeThoughtSummary,
        isCollapsedLabel: bindings.isCollapsedLabel,
        enabled: () => enabled,
      });
      const failedFeatures = decorations.features.filter((f) => !f.installed);
      if (failedFeatures.length) {
        const detail = failedFeatures.map((f) => `${f.name}: ${f.reason}`).join("; ");
        ctx.ui.notify(`pi-codex-appearance: decorations partially unavailable (${detail}).`, "warning");
      }
    }
  });

  /** Tone painter for footer/metadata text (the theme may be an unbound
   * proxy early on — degrade to plain text instead of crashing). */
  const makeTonePainter = (theme: { fg?: (key: string, text: string) => string } | undefined, colorLevel: ColorLevel) =>
    (text: string, tone: SegmentTone): string => {
      if (tone === "normal" || !text) return text;
      if (tone === "add" || tone === "del") {
        // Same green/red as the diff renderer — Codex has no theme key for them.
        const fg = diffSignFg(tone === "add" ? "add" : "remove", colorLevel);
        return fg ? `${fg}${text}\x1b[39m` : text;
      }
      const key = tone === "warning" ? "warning" : tone;
      try {
        return typeof theme?.fg === "function" ? theme.fg(key as never, text) : text;
      } catch {
        return text;
      }
    };

  /** Install the Codex-style chrome through PUBLIC host APIs only. Preloaded
   * modules install synchronously when ready; a preload resolving after the
   * generation changed (shutdown/new session) is dropped. */
  async function installChrome(facts: HostFacts, generation: number): Promise<void> {
    const ui = hostData.ui as Partial<{
      setEditorComponent: (factory: unknown) => void;
      getEditorComponent: () => unknown;
      setFooter: (factory: unknown) => void;
      setHeader: (factory: unknown) => void;
      setWidget: (key: string, content: unknown, options?: unknown) => void;
      setWorkingVisible: (visible: boolean) => void;
      setWorkingIndicator: (options?: unknown) => void;
    }>;
    const mods = await preloadChrome();
    if (!mods || generation !== chrome.generation) return;

    // Editor factory: Codex surface composer. The gray surface (when the
    // terminal can carry it and surface ops were injected) replaces the
    // accent borders; embedWorkingStatus is OFF — the Working line lives in
    // the above-editor widget.
    if (facts.available.setEditorComponent && !ui.getEditorComponent?.() && bindings.editorHost?.CustomEditor) {
      try {
        const surface = config.composer.surface ? bindings.surface : undefined;
        const factory = mods.makeCodexEditorFactory({
          host: bindings.editorHost as never,
          paddingX: 2,
          embedWorkingStatus: false,
          surface,
          promptPrefix: config.composer.promptPrefix,
          placeholder: "Ask anything...",
          selectionCopy: config.selectionCopy.ctrlC ? selectionCopy?.editorHook() : undefined,
        });
        chrome.editorFactory = factory;
        chrome.surfaceApplied = surface !== undefined;
        chrome.prefixApplied = surface !== undefined && config.composer.promptPrefix;
        ui.setEditorComponent?.(factory as never);
        chrome.editorInstalled = true;
      } catch { /* editor stays native */ }
    }

    // Composer metadata: same-surface belowEditor widget (model/effort/
    // provider + context). Only when the editor surface is active, so the
    // metadata never floats on a bare background.
    if (typeof ui.setWidget === "function" && config.composer.metadata && config.composer.surface && bindings.surface) {
      try {
        ui.setWidget(COMPOSER_META_WIDGET_KEY, (tui: unknown) => {
          captureTui(tui);
          const surface = bindings.surface!;
          return mods.createComposerMetaComponent({
            getSnapshot: getComposerMetaSnapshot,
            surface,
            paint: (text, tone) => (tone === "normal" ? text : surface.paintGlyph(text, tone === "accent" ? "accent" : "dim")),
          });
        }, { placement: "belowEditor" });
        chrome.metaInstalled = true;
      } catch { /* metadata stays off; the footer still renders */ }
    }

    // Footer: compact product status (cwd/branch · session I/O · cache ·
    // quota · optional R/W + cost).
    if (facts.available.setFooter && config.footer.enabled) {
      try {
        ui.setFooter?.((tui: unknown, theme: { fg?: (k: string, t: string) => string }, footerData: unknown) => {
          captureTui(tui);
          return mods.createFooterComponent(
            { getSnapshot: getFooterSnapshot, requestRender, show: footerShow() },
            footerData as never,
            makeTonePainter(theme, session.colorLevel),
          );
        });
        chrome.footerInstalled = true;
      } catch { /* footer stays native */ }
    }

    // Header: real identity line with real versions.
    if (facts.available.setHeader) {
      try {
        ui.setHeader?.((_tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) =>
          mods.createHeaderComponent(
            {
              appearanceVersion: bindings.appearanceVersion ?? "unknown",
              piVersion: bindings.piVersion ?? "unknown",
              getModel: () => hostData.getModel(),
              getCwd: () => hostData.getCwd(),
            },
            theme,
          ));
        chrome.headerInstalled = true;
      } catch { /* header stays native */ }
    }

    // Working: the standalone above-editor widget with the Codex rhythm.
    // The native loader row is hidden ONLY after the widget installed; without
    // setWidget the old message-based fallback stays (never two Working rows).
    if (typeof ui.setWidget === "function") {
      try {
        const factory = (tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) => {
          captureTui(tui);
          const paint = (text: string, tone: "accent" | "dim" | "normal"): string => {
            if (!text || tone === "normal") return text;
            try {
              return typeof theme?.fg === "function" ? theme.fg(tone as never, text) : text;
            } catch {
              return text;
            }
          };
          const component = mods.createWorkingComponent({
            getSnapshot: getWorkingSnapshot,
            getShow: workingShow,
            getAnimation: workingAnimation,
            requestRender,
            colorKind: session.colorLevel.kind,
            paint,
          });
          chrome.workingComponent = component;
          return component;
        };
        chrome.widgetFactory = factory;
        chrome.widgetInstalled = true;
        // agent_start may have fired while the preload resolved — if an
        // interaction is already active, show the widget immediately.
        setWidgetVisible(metrics.active);
        ui.setWorkingVisible?.(false);
        chrome.nativeLoaderHidden = true;
      } catch {
        chrome.widgetInstalled = false;
      }
    }
    if (!chrome.widgetInstalled && facts.available.setWorkingIndicator) {
      try {
        ui.setWorkingIndicator?.({ frames: ["●"], intervalMs: 1000 });
        chrome.fallbackMessage = true;
      } catch { /* native spinner keeps its default */ }
    }
  }

  const glyphStatus = (): string => {
    if (!glyphPresentation) return "disabled(config)";
    const g = glyphPresentation.status();
    if (!g.enabled) return "disabled(config)";
    const marks = g.glyphs.join(" ");
    return `${g.installed ? `applied (${g.reason})` : g.reason} marks=${g.glyphs.length} [${marks}] frames=${g.frames} changed=${g.changed}${config.glyphs.include.length > 0 ? ` include=${config.glyphs.include.join(" ")}` : ""}`;
  };

  const selectionCopyLine = (): string[] => {
    if (!selectionCopy) {
      return [`  selection-copy: ${config.selectionCopy.enabled ? "disabled (no host bindings)" : "disabled(config)"}`];
    }
    const d = selectionCopy.diagnostics();
    const t = d.telemetry;
    const m = d.mirrors;
    const lines = [
      `  selection-copy: serializer=${d.serializerInstalled ? (d.live ? "installed+live" : "installed-but-inert") : `not-installed (${d.installBlocker})`} mirrors(md/txt)=${m.markdownBuilt}/${m.textBuilt} built, ${m.markdownDegraded + m.textDegraded} degraded, ${m.markdownThrottled + m.textThrottled} throttled${m.lastDegradedReason ? ` (${m.lastDegradedReason})` : ""} other-wrapper=${d.externalPatch ?? "none"}`,
      `  copy-stats: calls=${t.calls ?? 0} exact=${t.exact} mixed=${t.mixed} native=${t.nativeFallback} empty=${t.emptyDecoration} failed=${t.failed} last=${t.lastMode} chars=${t.lastCharCount} ms=${t.lastDurationMs} cache=${d.cache.hits}/${d.cache.misses}${t.lastReason ? ` lastError=${t.lastReason}` : ""}`,
    ];
    return lines;
  };

  // /codex-ui — capability + data diagnostics. States are REAL outcomes
  // (installed/applied/disabled/fallback), never "capability exists".
  (bindings.api as { registerCommand?: (name: string, options: unknown) => void } | undefined)?.registerCommand?.("codex-ui", {
    description: "pi-codex-appearance capability diagnostics",
    handler: (args: string, commandCtx: { ui?: { notify?: (text: string) => void } }) => {
      let text: string;
      if (!hostData.bound) {
        text = "pi-codex-appearance: no active session";
      } else {
        if (typeof args === "string" && args.trim().toLowerCase() === "refresh-quota") {
          maybeRefreshQuota(true);
        }
        const model = hostData.getModel();
        const level = hostData.getThinkingLevel();
        const usage = hostData.getContextUsage();
        const snap = metrics.snapshot();
        const verdict = outcome.frozen ? outcome.freeze() : undefined;
        const fmt = (v: unknown): string => (v === undefined || v === null ? "—" : String(v));
        const quotaState = quotaStore?.state();
        const speed = outputSpeed.snapshot();
        const speedText = formatSpeed(speed?.tokensPerSecond);
        const speedDetail = speedText
          ? `${speedText} (output=${speed!.outputTokens} tokens, window=${(speed!.windowMs / 1000).toFixed(1)}s, scope=${speed!.scope})`
          : "— (no measured response yet)";
        const quotaAge = quotaStore?.lastSuccessAgeMs(Date.now());
        const quotaDetail = quotaState?.quota
          ? `primary=${quotaState.quota.primary ? `${Math.round(quotaState.quota.primary.remainingPercent * 10) / 10}%${quotaState.quota.primary.windowMinutes ? `/${quotaState.quota.primary.windowMinutes}min` : ""}` : "—"} secondary=${quotaState.quota.secondary ? `${Math.round(quotaState.quota.secondary.remainingPercent * 10) / 10}%` : "—"}`
          : "no snapshot";
        const changeStat = gitChanges.snapshot();
        const changesDetail = changeStat
          ? `+${changeStat.additions} -${changeStat.deletions} (${changeStat.files} files, session Δ vs ${gitChanges.session().rev ?? "index (unborn HEAD)"}${gitChanges.session().baseline ? " + baseline" : ""}, untracked included, ${GIT_CHANGES_INTERVAL_MS / 1000}s poll + ${GIT_CHANGES_DEBOUNCE_MS}ms activity refresh)`
          : "unavailable (no git metadata in cwd)";
        const lines = [
          `pi-codex-appearance ${bindings.appearanceVersion ?? "?"} diagnostics (mode=${hostData.mode}, pi=${bindings.piVersion ?? "?"}, revision=${hostData.revision}):`,
          `  composer: surface=${chrome.surfaceApplied ? "applied" : config.composer.surface ? `fallback (${bindings.surface ? "color level" : "no surface binding"})` : "disabled(config)"} prefix=${chrome.prefixApplied ? "applied" : "off"} metadata=${chrome.metaInstalled ? "applied" : config.composer.metadata ? "fallback" : "disabled(config)"}`,
          `  working: ${snap.active ? `active phase=${snap.phase} elapsed=${Math.round(snap.elapsedMs / 1000)}s thinking=${Math.round(snap.thinkingMs / 1000)}s${snap.thinkingOpen ? " (open)" : ""}` : "idle"} animation=${config.working.animation ? `on @${config.working.animationIntervalMs}ms` : "off"} interrupt-hint=esc (default fallback; host remap not exposed)`,
          `  footer: model source=live ctx (composer surface) context source=ctx.getContextUsage() session source=UsageLedger(session entries) cwd source=ctx.cwd`,
          `  model: id=${fmt(model?.id)} effort=${fmt(level)} provider=${fmt(model?.provider)} window=${fmt(model?.contextWindow)} (live ctx, rev ${hostData.revision})`,
          `  context: tokens=${fmt(usage?.tokens)}/${fmt(usage?.contextWindow)} percent=${fmt(usage?.percent)} — scope=live ctx`,
          `  session Σ: ${hostData.hasSessionManager
            ? `input=${ledger.totals().input} output=${ledger.totals().output} requests=${ledger.confirmedCount} — scope=this session file`
            : "unavailable (no sessionManager)"}`,
          `  cache(last)=${ledger.cacheRateLast() === null ? "—" : `${Math.round(ledger.cacheRateLast()! * 10) / 10}%`} — scope=latest confirmed request; ↑=uncached input per Pi normalization`,
          `  output speed: ${speedDetail} — confirmed usage.output ÷ observed output window; live only when the provider streams cumulative usage`,
          `  interaction usage (confirmed): ↑${snap.usage.input} ↓${snap.usage.output} — preview replaces, never sums`,
          `  outcome: ${verdict ? `${verdict.outcome} (evidence=${verdict.evidence}, attempt=${verdict.attempt}, toolErrors=${verdict.toolErrorsObserved}) — ${verdict.reason}` : `pending (attempts=${outcome.attemptCount}, toolErrors=${outcome.toolErrorsObserved})`}`,
          `  codex quota: mode=${config.quota.codex} source=codex-app-server available=${quotaState?.quota ? "yes" : quotaState?.lastErrorClass ? "no" : "unknown"} lastSuccess=${quotaAge === undefined ? "never" : `${Math.round(quotaAge / 1000)}s ago`} ${quotaDetail} stale=${quotaState?.stale ? "yes" : "no"} lastError=${quotaState?.lastErrorClass ?? "—"}`,
          `  chrome: editor=${chrome.editorInstalled ? "applied" : "native"} footer=${chrome.footerInstalled ? "applied" : "native/off"} header=${chrome.headerInstalled ? "applied" : "native"} working=${chrome.widgetInstalled ? "widget" : chrome.fallbackMessage ? "fallback(message)" : "native"}`,
          `  transcript: ${handle?.installed ? "applied" : handle ? `failed: ${handle.reason}` : "not installed"}`,
          `  decorations: ${decorations ? decorations.features.map((f) => `${f.name}=${f.installed ? "applied" : `failed: ${f.reason}`}`).join(", ") : "unavailable (no assistant prototype binding)"}`,
          `  thinking: policy=${config.thinking.streaming}/${config.thinking.completed} peekLines=${config.thinking.peekLines} autoVisibility=${decorations?.thinkingAutoApplied?.() ?? "n/a"} (host override-map transitions applied once)`,
          `  fullscreen-margin: ${fullscreenMargin ? (fullscreenMargin.status().installed ? `applied (margin=${config.fullscreen.marginX}, minWidth=${config.fullscreen.minWidth})` : fullscreenMargin.status().reason) : config.fullscreen.marginX > 0 ? "unavailable (no host bindings)" : "disabled(config)"}`,
          `  glyphs: ${glyphStatus()}`, 
          `  config: enabled=${config.enabled} composer=${config.composer.surface ? `surface,prefix=${config.composer.promptPrefix},meta=${config.composer.metadata}` : "off"} working=${`elapsed=${config.working.elapsed},thought=${config.working.thought},tool=${config.working.tool},tokens=${config.working.tokens},anim=${config.working.animation}@${config.working.animationIntervalMs}ms`} footer=${config.footer.enabled ? `details=${config.footer.details},cache=${config.footer.showCache},changes=${config.footer.showChanges},quota=${config.footer.showCodexQuota},speed=${config.footer.showSpeed}` : "off"} quota=${config.quota.codex}/${config.quota.refreshSeconds}s thinking=${config.thinking.streaming}/${config.thinking.completed} writePreview=${config.writePreview.enabled ? `${config.writePreview.rows} rows` : "off"} summary=${config.summary.enabled ? `persist=${config.summary.persist}` : "off"}`,
          `  resources: ticker=${metrics.tickerAlive ? "alive" : "stopped"} working-timer=active-only quota-timer=${quotaTimer ? `every ${config.quota.refreshSeconds}s` : "stopped"} git-timer=${gitChanges.running ? `every ${GIT_CHANGES_INTERVAL_MS / 1000}s + activity` : "stopped"} widget=${chrome.widgetInstalled ? "installed" : "none"}`,
          `  git-changes: ${changesDetail}`,
          ...selectionCopyLine(),
          `  history-window: ${JSON.stringify(historyWindow?.status() ?? { installed: false })}`,
        ];
        text = lines.join("\n");
      }
      // Return values are ignored by the host; surface via the command ctx.
      commandCtx?.ui?.notify?.(text);
    },
  });

  /** Look up a tool entry's sourceInfo (exact builtin ownership checks). */
  function sourceInfoFor(toolName: string): unknown {
    try {
      const entry = pi.getAllTools().find((tool) =>
        tool !== null && typeof tool === "object" && (tool as Record<string, unknown>).name === toolName);
      return entry ? (entry as Record<string, unknown>).sourceInfo : undefined;
    } catch {
      return undefined;
    }
  }

  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content); all state is ephemeral presentation data dropped at shutdown.
  (pi as unknown as AppearanceAPI).on("agent_start", () => {
    if (!chromeEnabled) return;
    if (selectionCopy && serializerHost) selectionCopy.installOnTui(serializerHost);
    if (fullscreenMargin && serializerHost) fullscreenMargin.installOnTui(serializerHost);
    if (!metrics.active) {
      // First start of a chain: a genuinely new interaction — no outcome or
      // tool-error state may leak across interactions.
      outcome.reset();
      const u = hostData.ui as { setStatus?: (key: string, text: string | undefined) => void };
      try {
        u.setStatus?.(SUMMARY_STATUS_KEY, undefined);
      } catch { /* status slot is best-effort */ }
    }
    metrics.agentStart();
    setWidgetVisible(true);
  });
  (pi as unknown as AppearanceAPI).on("agent_end", () => {
    if (!chromeEnabled) return;
    metrics.agentEnd();
  });
  (pi as unknown as AppearanceAPI).on("agent_settled", () => {
    if (!chromeEnabled) return;
    metrics.agentSettled();
    outcome.reset();
    // Quota: the interaction just consumed request capacity — refresh when
    // the last refresh is older than 30s (coalesced inside the store).
    if (quotaStore && Date.now() - lastQuotaRefreshAt > 30_000) maybeRefreshQuota(true);
  });

  // Model/effort switches and session-structure events refresh the snapshot
  // revision; the metadata/footer read everything from one revision per render.
  const refreshHost = () => {
    hostData.bump();
    requestRender();
  };
  for (const event of ["model_select", "thinking_level_select", "session_compact_failed"] as const) pi.on(event, refreshHost);
  for (const event of ["session_tree", "session_compact"] as const) {
    pi.on(event, () => {
      ledger.rebuild(hostData.getSessionEntries());
      refreshHost();
    });
  }
  pi.on("ui_prompt_start", () => {
    if (!chromeEnabled) return;
    metrics.uiPromptStart();
    requestRender();
  });
  pi.on("ui_prompt_end", () => {
    if (!chromeEnabled) return;
    metrics.uiPromptEnd();
    requestRender();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled) return;
    const info = sourceInfoFor(event.toolName);
    tracker.trackStart(event.toolCallId, event.toolName, event.args, info, (path) => resolveWritePath(path, ctx.cwd));
    transcript.apply({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName });
    if (chromeEnabled) metrics.toolStart(event.toolCallId, event.toolName);
    if (chromeEnabled && event.toolName === "write") metrics.writeStreaming();
  });
  pi.on("tool_execution_end", (event) => {
    if (!enabled) return;
    // A tool error is a DIAGNOSTIC count only — it never sets the verdict.
    if (event.isError === true && chromeEnabled) outcome.toolError();
    const info = sourceInfoFor(event.toolName);
    const change = tracker.trackEnd(event.toolCallId, event.toolName, info, event.isError);
    if (change) {
      session.writeChanges.set(event.toolCallId, change);
      if (session.writeChanges.size > MAX_WRITE_CHANGES) {
        const oldest = session.writeChanges.keys().next().value;
        if (oldest !== undefined) session.writeChanges.delete(oldest);
      }
    }
    // Image count from the real result content blocks (count only, no copy).
    const images = countImageBlocks(event.result);
    transcript.apply({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError === true, imageCount: images });
    if (chromeEnabled) metrics.toolEnd(event.toolCallId);
  });

  // Keep the original message object as the state machine's identity anchor.
  pi.on("message_start", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    transcript.apply({ type: "message_start", message: toStateMessage(message) }, message);
    if (!chromeEnabled) return;
    if (isUserMessage(message)) metrics.uiPromptEnd();
    const role = (message as Record<string, unknown> | undefined)?.role;
    if (typeof role === "string") outcome.messageStart(role);
    // One speed window per assistant response (request sent → message_end).
    if (role === "assistant") outputSpeed.requestStart();
  });
  pi.on("message_update", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    const stateMessage = toStateMessage(message);
    transcript.apply({ type: "message_update", message: stateMessage }, message);
    if (!chromeEnabled) return;
    // Phase feed for the Working line: the CURRENT streaming event decides
    // the phase — never the accumulated content. An old thinking block must
    // NOT keep "Thinking" lit while the model streams a write tool call.
    const streamEvent = (event as { assistantMessageEvent?: { type?: string; contentIndex?: number; partial?: { content?: Array<Record<string, unknown>> } } }).assistantMessageEvent;
    const eventType = typeof streamEvent?.type === "string" ? streamEvent.type : undefined;
    if (stateMessage && stateMessage.role === "assistant" && eventType) {
      // Output speed measures real token arrival: only *_delta events open and
      // extend the window (structural start/end events carry no content).
      if (eventType.endsWith("_delta")) outputSpeed.delta();
      const content = streamEvent?.partial?.content ?? [];
      const at = (idx: number | undefined) => (typeof idx === "number" ? content[idx] : undefined);
      switch (eventType) {
        case "thinking_start":
        case "thinking_delta":
          metrics.thinkingStart();
          break;
        case "thinking_end":
          metrics.thinkingEnd();
          break;
        case "text_start":
        case "text_delta":
        case "text_end":
          metrics.thinkingEnd();
          metrics.setPhase("working");
          break;
        case "toolcall_start":
        case "toolcall_delta":
        case "toolcall_end": {
          metrics.thinkingEnd();
          const toolCall = eventType === "toolcall_end" ? (streamEvent as { toolCall?: { name?: unknown } }).toolCall : undefined;
          const block = at(streamEvent?.contentIndex);
          const toolName = typeof toolCall?.name === "string" ? toolCall.name
            : typeof block?.name === "string" ? block.name : undefined;
          if (toolName === "write") metrics.writeStreaming();
          else metrics.setPhase("working");
          break;
        }
        default:
          break; // start/done/error: no phase change (done handled at message_end)
      }
    }
    // Streaming usage is a CUMULATIVE snapshot — replace the preview for the
    // current attempt (per-delta summing is forbidden).
    if (stateMessage?.role === "assistant" && outcome.attemptCount > 0) {
      const usage = (message as Record<string, unknown> | undefined)?.usage as RawUsage | undefined;
      if (usage && typeof usage === "object") {
        const tokens = sanitizeUsage(usage);
        metrics.previewUsage(outcome.attemptCount, tokens);
        // Live rate only when the provider publishes cumulative output tokens
        // mid-stream; otherwise the value lands once at message_end.
        if (outputSpeed.preview(tokens.output ?? 0)) requestRender();
      }
    }
  });
  pi.on("message_end", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    const stateMessage = toStateMessage(message);
    transcript.apply({ type: "message_end", message: stateMessage }, message);
    if (!chromeEnabled) return;
    metrics.thinkingEnd();
    if (stateMessage?.stopReason) outcome.terminalStop(stateMessage.stopReason);
    // Usage totals (read-only): same key for the interaction metrics and the
    // session ledger — replays/duplicate completions never double-count.
    if (message && typeof message === "object") {
      const record = message as Record<string, unknown>;
      const usage = record.usage as RawUsage | undefined;
      if (usage && typeof usage === "object") {
        const { key, identified } = usageKeyOf(record);
        metrics.recordUsage(key, sanitizeUsage(usage), identified);
        ledger.confirm(key, usage);
        metrics.clearPreviewUsage(outcome.attemptCount);
      }
      // Close the speed window on the confirmed output count (a response with
      // no usage records nothing — the previous sample stays displayed).
      if (stateMessage?.role === "assistant") {
        outputSpeed.finish(usage ? (sanitizeUsage(usage).output ?? 0) : 0);
      }
    }
  });

  pi.on("session_shutdown", () => {
    enabled = false;
    chromeEnabled = false;
    chrome.generation += 1;
    handle?.dispose();
    handle = undefined;
    decorations?.dispose();
    decorations = undefined;
    historyWindow?.dispose();
    fullscreenMargin?.dispose();
    // Chrome restore: only OUR factories are removed (identity comparison);
    // a successor extension's editor/footer/header is left untouched.
    const ui = hostData.ui as Partial<{
      setEditorComponent: (factory: unknown) => void;
      getEditorComponent: () => unknown;
      setFooter: (factory: unknown) => void;
      setHeader: (factory: unknown) => void;
      setWidget: (key: string, content: unknown, options?: unknown) => void;
      setWorkingVisible: (visible: boolean) => void;
      setWorkingMessage: (message?: string) => void;
      setStatus: (key: string, text: string | undefined) => void;
    }>;
    try {
      if (chrome.editorFactory && ui.getEditorComponent?.() === chrome.editorFactory) {
        ui.setEditorComponent?.(undefined);
      }
    } catch { /* keep current editor */ }
    chrome.editorFactory = undefined;
    chrome.editorInstalled = false;
    chrome.surfaceApplied = false;
    chrome.prefixApplied = false;
    try {
      if (chrome.footerInstalled) ui.setFooter?.(undefined);
    } catch { /* keep current footer */ }
    chrome.footerInstalled = false;
    try {
      if (chrome.headerInstalled) ui.setHeader?.(undefined);
    } catch { /* keep current header */ }
    chrome.headerInstalled = false;
    try {
      if (chrome.metaInstalled) ui.setWidget?.(COMPOSER_META_WIDGET_KEY, undefined);
    } catch { /* keep widget slot */ }
    chrome.metaInstalled = false;
    try {
      if (chrome.widgetInstalled) ui.setWidget?.(WORKING_WIDGET_KEY, undefined);
    } catch { /* keep widget slot */ }
    chrome.widgetInstalled = false;
    chrome.widgetFactory = undefined;
    chrome.workingComponent?.stopAnimation();
    chrome.workingComponent = undefined;
    if (chrome.nativeLoaderHidden) {
      try {
        ui.setWorkingVisible?.(true);
      } catch { /* native loader state is the host's */ }
      chrome.nativeLoaderHidden = false;
    }
    chrome.fallbackMessage = false;
    try {
      ui.setWorkingMessage?.();
      ui.setStatus?.(SUMMARY_STATUS_KEY, undefined);
    } catch { /* status slot is best-effort */ }
    chrome.tui = undefined;
    stopQuotaTimer();
    quotaStore?.reset();
    lastQuotaRefreshAt = 0;
    gitChanges.dispose();
    session.writeChanges.clear();
    transcript.resetSession();
    metrics.reset();
    outcome.reset();
    outputSpeed.reset();
    ledger.reset();
    turnSummary.forgetSession();
    hostData.bind(undefined);
  });
}

function isUserMessage(message: unknown): boolean {
  return (message as Record<string, unknown> | undefined)?.role === "user";
}

// Re-exported for tests that verify display rules without the host.
export { formatTokensCompact };
