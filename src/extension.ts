import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { installTranscriptDecorations, type DecorationHandle } from "./transcript-adapter.ts";
import { TranscriptState, type TranscriptEvent } from "./transcript-state.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";
import { UiMetrics, WORKING_PHASE_LABEL, formatDuration } from "./ui-metrics.ts";
import { TurnSummary, SUMMARY_CUSTOM_TYPE, formatSummaryLine } from "./turn-summary.ts";
import { probeHost, type HostFacts } from "./host-compat.ts";
import { loadConfig, type AppearanceConfig } from "./config.ts";
import { HostData, type HostContextLike } from "./host-data.ts";
import { UsageLedger } from "./usage-ledger.ts";
import { InteractionOutcomeTracker } from "./interaction-outcome.ts";
import { WORKING_WIDGET_KEY, createWorkingComponent, type WorkingShow, type WorkingSnapshot } from "./chrome/working.ts";
import type { FooterShow, FooterSnapshot } from "./chrome/footer.ts";

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
  /** Detect an external owner that already renders thinking rails. */
  externalRailOwner?: () => boolean;
  /** Build the live write call component (header + stage + preview body). */
  makeWriteCall?: import("./renderers.ts").WritePreviewInput extends infer T
    ? (input: T & { headerText: string }) => import("./tool-names.ts").Component | undefined
    : never;

  /** Host CustomEditor class for the chrome editor factory (index.ts only). */
  editorHost?: { CustomEditor: unknown };
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
}

/** Session-scoped presentation state (ephemeral, display-only). */
export interface AppearanceSession {
  tracker: WriteDiffTracker;
  colorLevel: ColorLevel;
  /** Completed write diffs keyed by toolCallId; entries are pruned on read. */
  readonly writeChanges: Map<string, WriteDiff>;
  /** Display-order projection (exploration groups + text boundaries). */
  readonly transcript: TranscriptState;
  /** toolCallId → image-block count from the REAL result content. */
  readonly resultImages: Map<string, number>;
}

/** Bounded store for completed write diffs (entry + total budget). */
const MAX_WRITE_CHANGES = 64;
const MAX_IMAGE_ENTRIES = 256;
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

interface UsageFields {
  input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown;
  cost?: { total?: unknown };
}

/** Boundary sanitize: only finite, non-negative numbers cross into the
 * metrics/ledger numeric types (unknown → omitted, never NaN/-1). */
function sanitizeUsage(usage: UsageFields): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } {
  const pick = (v: unknown): number | undefined =>
    (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const out: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
  const input = pick(usage.input);
  const output = pick(usage.output);
  const cacheRead = pick(usage.cacheRead);
  const cacheWrite = pick(usage.cacheWrite);
  if (input !== undefined) out.input = input;
  if (output !== undefined) out.output = output;
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return out;
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
  const session: AppearanceSession = {
    tracker: new WriteDiffTracker(),
    colorLevel: bindings.colorLevel ?? detectColorLevel(),
    writeChanges: new Map<string, WriteDiff>(),
    transcript,
    resultImages: new Map<string, number>(),
  };

  // Data bridge + ledgers (all display data flows through these).
  const hostData = new HostData();
  const ledger = new UsageLedger();
  const outcome = new InteractionOutcomeTracker();
  let config: AppearanceConfig = loadConfig(bindings.getAgentDir?.(), bindings.readFile).config;

  // Chrome install state. `generation` invalidates late async installs:
  // a preload resolving after shutdown/new-session must not touch the new UI.
  const chrome = {
    generation: 0,
    editorFactory: undefined as object | undefined,
    editorInstalled: false,
    footerInstalled: false,
    headerInstalled: false,
    widgetInstalled: false,
    widgetFactory: undefined as unknown,
    nativeLoaderHidden: false,
    fallbackMessage: false,
    tui: undefined as { requestRender?: () => void } | undefined,
  };
  type ChromeMods = typeof import("./chrome/editor.ts") & typeof import("./chrome/footer.ts") & typeof import("./chrome/header.ts") & typeof import("./chrome/working.ts");
  let chromeMods: Promise<ChromeMods | undefined> | undefined;
  const preloadChrome = (): Promise<ChromeMods | undefined> => {
    chromeMods ??= Promise.all([
      import("./chrome/editor.ts"),
      import("./chrome/footer.ts"),
      import("./chrome/header.ts"),
      import("./chrome/working.ts"),
    ]).then(([editor, footer, header, working]) => ({ ...editor, ...footer, ...header, ...working }))
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

  /** The factory-time tui is the only reliable requestRender source. */
  const captureTui = (tui: unknown): void => {
    if (chrome.tui || !tui || typeof tui !== "object") return;
    const rr = (tui as { requestRender?: unknown }).requestRender;
    if (typeof rr === "function") chrome.tui = tui as { requestRender?: () => void };
  };

  const footerShow = (): FooterShow => ({
    details: config.footer.details,
    showCache: config.footer.showCache,
    showCost: config.footer.showCost,
  });
  const workingShow = (): WorkingShow => ({
    elapsed: config.working.elapsed,
    thought: config.working.thought,
    tool: config.working.tool,
    tokens: config.working.tokens,
  });
  const getWorkingSnapshot = (): WorkingSnapshot => {
    const s = metrics.snapshot();
    return {
      active: s.active,
      phase: s.phase,
      elapsedMs: s.elapsedMs,
      thinkingMs: s.thinkingMs,
      thinkingOpen: s.thinkingOpen,
      usage: { input: s.usage.input, output: s.usage.output },
      tools: s.tools,
    };
  };
  const getFooterSnapshot = (): FooterSnapshot => ({
    model: hostData.getModel(),
    thinkingLevel: hostData.getThinkingLevel(),
    contextUsage: hostData.getContextUsage(),
    cwd: hostData.getCwd(),
    session: hostData.hasSessionManager ? ledger.totals() : undefined,
    cacheLastPct: ledger.cacheRateLast(),
    cacheSessionPct: ledger.cacheRateSession(),
    revision: hostData.revision,
  });

  const metrics = new UiMetrics(
    { now: () => performance.now(), wall: () => Date.now() },
    {
      onTick: (snapshot) => {
        if (!chromeEnabled) return;
        if (chrome.widgetInstalled) {
          // The widget component reads the snapshot at render; a 1s tick just
          // asks the host for a frame. No per-token reinstalls.
          requestRender();
          return;
        }
        if (chrome.fallbackMessage && config.working.elapsed) {
          const ui = hostData.ui as { setWorkingMessage?: (message?: string) => void };
          const label = WORKING_PHASE_LABEL[snapshot.phase];
          ui.setWorkingMessage?.(`${label} · ${formatDuration(snapshot.elapsedMs)}`);
        }
      },
      onSettled: (snapshot) => {
        if (!chromeEnabled) return;
        // Hide the active widget; the transcript summary carries the result.
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
    ledger.reset();
    ledger.rebuild(hostData.getSessionEntries(), SUMMARY_CUSTOM_TYPE);
    outcome.reset();
    const facts: HostFacts = probeHost({ ui: hostData.ui as never, mode: hostData.mode, hasUI: hostData.hasUI });
    enabled = facts.isTui || full.hasUI === true;
    // Chrome/metrics/summary side effects only in the REAL TUI process and
    // only while enabled — print/json/rpc never get timers or ANSI.
    chromeEnabled = facts.isTui && config.enabled !== false;
    if (chromeEnabled) {
      void installChrome(facts, chrome.generation);
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
      decorations = installTranscriptDecorations({
        state: transcript,
        toolPrototype: bindings.prototype,
        assistantPrototype: bindings.assistantPrototype,
        makeSeparator: bindings.makeSeparator,
        makeSpacer: bindings.makeSpacer ?? (() => undefined),
        makeRail: bindings.makeRail,
        externalRailOwner: bindings.externalRailOwner,
        enabled: () => enabled,
      });
      const failedFeatures = decorations.features.filter((f) => !f.installed);
      if (failedFeatures.length) {
        const detail = failedFeatures.map((f) => `${f.name}: ${f.reason}`).join("; ");
        ctx.ui.notify(`pi-codex-appearance: decorations partially unavailable (${detail}).`, "warning");
      }
    }
  });

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

    // Editor factory: Codex-look composer. embedWorkingStatus is OFF — the
    // Working line lives in the above-editor widget, not the border.
    if (facts.available.setEditorComponent && !ui.getEditorComponent?.() && bindings.editorHost?.CustomEditor) {
      try {
        const factory = mods.makeCodexEditorFactory({
          host: bindings.editorHost as never,
          paddingX: 2,
          embedWorkingStatus: false,
        });
        chrome.editorFactory = factory;
        ui.setEditorComponent?.(factory as never);
        chrome.editorInstalled = true;
      } catch { /* editor stays native */ }
    }

    // Footer: two detail lines (model/effort/provider/context + Σ tokens/cache).
    if (facts.available.setFooter && config.footer.enabled) {
      try {
        ui.setFooter?.((tui: unknown, theme: { fg?: (k: string, t: string) => string }, footerData: unknown) => {
          captureTui(tui);
          return mods.createFooterComponent(
            { getSnapshot: getFooterSnapshot, requestRender },
            footerData as never,
            theme,
            footerShow(),
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

    // Working: the standalone above-editor widget. The native loader row is
    // hidden ONLY after the widget installed; without setWidget the old
    // message-based fallback stays in place (never three Working copies).
    if (typeof ui.setWidget === "function") {
      try {
        const factory = (tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) => {
          captureTui(tui);
          const paint = (key: string, text: string): string => {
            try {
              return typeof theme?.fg === "function" ? theme.fg(key as never, text) : text;
            } catch {
              return text;
            }
          };
          return mods.createWorkingComponent({
            getSnapshot: getWorkingSnapshot,
            getShow: workingShow,
            accent: (text) => paint("accent", text),
            dim: (text) => paint("dim", text),
          });
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

  // /codex-ui — capability + data diagnostics. States are REAL outcomes
  // (installed/applied/disabled/fallback), never "capability exists".
  (bindings.api as { registerCommand?: (name: string, options: unknown) => void } | undefined)?.registerCommand?.("codex-ui", {
    description: "pi-codex-appearance capability diagnostics",
    handler: (_args: string, commandCtx: { ui?: { notify?: (text: string) => void } }) => {
      let text: string;
      if (!hostData.bound) {
        text = "pi-codex-appearance: no active session";
      } else {
        const facts = probeHost({ ui: hostData.ui as never, mode: hostData.mode, hasUI: hostData.hasUI });
        const model = hostData.getModel();
        const level = hostData.getThinkingLevel();
        const usage = hostData.getContextUsage();
        const snap = metrics.snapshot();
        const verdict = outcome.frozen ? outcome.freeze() : undefined;
        const fmt = (v: unknown): string => (v === undefined || v === null ? "—" : String(v));
        const lines = [
          `pi-codex-appearance ${bindings.appearanceVersion ?? "?"} diagnostics (mode=${hostData.mode}, pi=${bindings.piVersion ?? "?"}, revision=${hostData.revision}):`,
          `  model: id=${fmt(model?.id)} effort=${fmt(level)} provider=${fmt(model?.provider)} window=${fmt(model?.contextWindow)} (live ctx, rev ${hostData.revision})`,
          `  context: tokens=${fmt(usage?.tokens)}/${fmt(usage?.contextWindow)} percent=${fmt(usage?.percent)} — scope=live ctx`,
          `  session Σ: ${hostData.hasSessionManager
            ? `input=${ledger.totals().input} output=${ledger.totals().output} cacheRead=${ledger.totals().cacheRead} cacheWrite=${ledger.totals().cacheWrite} requests=${ledger.confirmedCount} — scope=this session file`
            : "unavailable (no sessionManager)"}`,
          `  cache(last)=${ledger.cacheRateLast() === null ? "—" : `${Math.round(ledger.cacheRateLast()! * 10) / 10}%`} cache(session)=${ledger.cacheRateSession() === null ? "—" : `${Math.round(ledger.cacheRateSession()! * 10) / 10}%`} — scope=last confirmed request / session weighted`,
          `  interaction: ${snap.active ? `open elapsed=${Math.round(snap.elapsedMs / 1000)}s phase=${snap.phase} tools=${snap.tools ? `${snap.tools.first}${snap.tools.count > 1 ? ` +${snap.tools.count - 1}` : ""}` : "—"} thinking=${Math.round(snap.thinkingMs / 1000)}s${snap.thinkingOpen ? " (open)" : ""}` : "idle"}`,
          `  interaction usage (confirmed): ↑${snap.usage.input} ↓${snap.usage.output} R${snap.usage.cacheRead} W${snap.usage.cacheWrite} — preview replaces, never sums`,
          `  outcome: ${verdict ? `${verdict.outcome} (evidence=${verdict.evidence}, attempt=${verdict.attempt}, toolErrors=${verdict.toolErrorsObserved}) — ${verdict.reason}` : `pending (attempts=${outcome.attemptCount}, toolErrors=${outcome.toolErrorsObserved})`}`,
          `  chrome: editor=${chrome.editorInstalled ? "applied" : "native"} footer=${chrome.footerInstalled ? "applied" : facts.available.setFooter ? "native" : "unsupported"} header=${chrome.headerInstalled ? "applied" : "native"} working=${chrome.widgetInstalled ? "widget" : chrome.fallbackMessage ? "fallback(message)" : "native"}`,
          `  transcript: ${handle?.installed ? "applied" : handle ? `failed: ${handle.reason}` : "not installed"}`,
          `  decorations: ${decorations ? decorations.features.map((f) => `${f.name}=${f.installed ? "applied" : `failed: ${f.reason}`}`).join(", ") : "unavailable (no assistant prototype binding)"}`,
          `  config: enabled=${config.enabled} thinking=${config.thinking.streaming}/${config.thinking.completed} rail=${config.thinking.rail} writePreview=${config.writePreview.enabled ? `${config.writePreview.rows} rows` : "off"} footer=${config.footer.enabled ? `details=${config.footer.details},cache=${config.footer.showCache},cost=${config.footer.showCost}` : "off"} working=${`elapsed=${config.working.elapsed},thought=${config.working.thought},tool=${config.working.tool},tokens=${config.working.tokens}`} summary=${config.summary.enabled ? `persist=${config.summary.persist}` : "off"}`,
          `  resources: ticker=${metrics.tickerAlive ? "alive" : "stopped"} widget=${chrome.widgetInstalled ? "installed" : "none"}`,
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

  /** Exact builtin ownership (same rule as adapter.ts replacement()). */
  function ownsBuiltin(toolName: string): boolean {
    const source = sourceInfoFor(toolName) as Record<string, unknown> | undefined;
    return source?.source === "builtin" && source?.path === `<builtin:${toolName}>`;
  }
  void ownsBuiltin;


  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content); all state is ephemeral presentation data dropped at shutdown.
  (pi as unknown as AppearanceAPI).on("agent_start", () => {
    if (!chromeEnabled) return;
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
  });

  // Model/effort switches and session-structure events refresh the snapshot
  // revision; the footer reads everything from one revision per render.
  pi.on("model_select", () => {
    hostData.bump();
    requestRender();
  });
  pi.on("thinking_level_select", () => {
    hostData.bump();
    requestRender();
  });
  pi.on("session_tree", () => {
    ledger.rebuild(hostData.getSessionEntries(), SUMMARY_CUSTOM_TYPE);
    hostData.bump();
    requestRender();
  });
  pi.on("session_compact", () => {
    ledger.rebuild(hostData.getSessionEntries(), SUMMARY_CUSTOM_TYPE);
    hostData.bump();
    requestRender();
  });
  pi.on("session_compact_failed", () => {
    hostData.bump();
    requestRender();
  });
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
    session.tracker.trackStart(event.toolCallId, event.toolName, event.args, info, (path) => resolveWritePath(path, ctx.cwd));
    transcript.apply({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName });
    if (chromeEnabled) metrics.toolStart(event.toolCallId, event.toolName);
    if (chromeEnabled && event.toolName === "write") metrics.writeStreaming();
  });
  pi.on("tool_execution_end", (event) => {
    if (!enabled) return;
    // A tool error is a DIAGNOSTIC count only — it never sets the verdict.
    if (event.isError === true && chromeEnabled) outcome.toolError();
    const info = sourceInfoFor(event.toolName);
    const change = session.tracker.trackEnd(event.toolCallId, event.toolName, info, event.isError);
    if (change) {
      session.writeChanges.set(event.toolCallId, change);
      if (session.writeChanges.size > MAX_WRITE_CHANGES) {
        const oldest = session.writeChanges.keys().next().value;
        if (oldest !== undefined) session.writeChanges.delete(oldest);
      }
    }
    // Image count from the real result content blocks (count only, no copy).
    const images = countImageBlocks(event.result);
    if (images > 0) {
      session.resultImages.set(event.toolCallId, images);
      if (session.resultImages.size > MAX_IMAGE_ENTRIES) {
        const oldest = session.resultImages.keys().next().value;
        if (oldest !== undefined) session.resultImages.delete(oldest);
      }
    }
    transcript.apply({ type: "tool_execution_end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError === true, imageCount: images });
    if (chromeEnabled) metrics.toolEnd(event.toolCallId);
  });

  // Wire the real message handlers (typed loosely above to avoid importing
  // host event types; only read-only content-shape fields are read). The
  // event's message OBJECT is passed as the identity anchor so the state
  // machine can key plans by the host's own object identity.
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_start", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    transcript.apply({ type: "message_start", message: toStateMessage(message) }, message);
    if (!chromeEnabled) return;
    if (isUserMessage(message)) metrics.uiPromptEnd();
    const role = (message as Record<string, unknown> | undefined)?.role;
    if (typeof role === "string") outcome.messageStart(role);
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_update", (event) => {
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
        case "toolcall_delta": {
          metrics.thinkingEnd();
          const block = at(streamEvent?.contentIndex);
          const toolName = typeof block?.name === "string" ? block.name : undefined;
          if (toolName === "write") metrics.writeStreaming();
          else metrics.setPhase("working");
          break;
        }
        case "toolcall_end": {
          metrics.thinkingEnd();
          const toolCall = (streamEvent as { toolCall?: { name?: unknown } }).toolCall;
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
    if (chromeEnabled && stateMessage?.role === "assistant" && outcome.attemptCount > 0) {
      const usage = (message as Record<string, unknown> | undefined)?.usage as UsageFields | undefined;
      if (usage && typeof usage === "object") {
        metrics.previewUsage(outcome.attemptCount, sanitizeUsage(usage));
      }
    }
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_end", (event) => {
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
      const usage = record.usage as UsageFields | undefined;
      if (usage && typeof usage === "object") {
        const { key, identified } = usageKeyOf(record);
        metrics.recordUsage(key, sanitizeUsage(usage), identified);
        ledger.confirm(key, usage);
        metrics.clearPreviewUsage(outcome.attemptCount);
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
    try {
      if (chrome.footerInstalled) ui.setFooter?.(undefined);
    } catch { /* keep current footer */ }
    chrome.footerInstalled = false;
    try {
      if (chrome.headerInstalled) ui.setHeader?.(undefined);
    } catch { /* keep current header */ }
    chrome.headerInstalled = false;
    try {
      if (chrome.widgetInstalled) ui.setWidget?.(WORKING_WIDGET_KEY, undefined);
    } catch { /* keep widget slot */ }
    chrome.widgetInstalled = false;
    chrome.widgetFactory = undefined;
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
    session.writeChanges.clear();
    session.resultImages.clear();
    transcript.resetSession();
    metrics.reset();
    outcome.reset();
    ledger.reset();
    turnSummary.forgetSession();
    hostData.bind(undefined);
  });
}

function isUserMessage(message: unknown): boolean {
  return (message as Record<string, unknown> | undefined)?.role === "user";
}
