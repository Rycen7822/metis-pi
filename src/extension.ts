import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { createOwnedApplyPatchView } from "./apply-patch-view.ts";
import { highlightBashScript } from "./bash-lexer.ts";
import { installStartupWarningFilter } from "./startup-warning-filter.ts";
import { installTranscriptDecorations, type DecorationHandle, type ThinkingPolicy, type TranscriptAdapterInput } from "./transcript-adapter.ts";
import { TranscriptState, normalizeMessageBlocks, type TranscriptEvent } from "./transcript-state.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories, type WritePreviewInput } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";
import { UiMetrics, formatDuration } from "./ui-metrics.ts";
import { OutputSpeedTracker } from "./output-speed.ts";
import { TurnSummary, formatSummaryLine } from "./turn-summary.ts";
import { loadConfig, type AppearanceConfig } from "./config.ts";
import { HostData, type HostContextLike } from "./host-data.ts";
import { UsageLedger, sanitizeUsage, usageKeyOf, type RawUsage } from "./usage-ledger.ts";
import { InteractionOutcomeTracker } from "./interaction-outcome.ts";
import { createGitChangesTracker } from "./git-changes.ts";
import { createGlyphPresentation } from "./glyph-presentation.ts";
import { createSnapshotSource } from "./chrome/snapshots.ts";
import { createChromeLifecycle, SUMMARY_STATUS_KEY } from "./chrome/install.ts";
import { registerDiagnosticsCommand } from "./diagnostics.ts";
import type { CodexSurfaceOps } from "./chrome/editor.ts";
import { createSelectionCopySystem, type SelectionCopyHost, type SelectionCopySystem } from "./selection-copy/index.ts";
import { createFullscreenMargin, type FullscreenMarginHost, type FullscreenMarginSystem } from "./chrome/fullscreen-margin.ts";
import { createHistoryWindowSystem, type HistoryWindowHost } from "./chrome/history-window.ts";

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
// Decoration factories have one contract, owned by the adapter that consumes them.
export interface Bindings extends Partial<Pick<TranscriptAdapterInput,
  "makeSeparator" | "makeSpacer" | "makeRail" | "makeThoughtSummary" |
  "isCollapsedLabel" | "makePeek" | "makeClickable"
>> {
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
  /** Host TUI classes/primitives for the selection-copy system (index.ts). */
  selectionCopyHost?: SelectionCopyHost;
  /** Host TUI HStack/Spacer constructors for the fullscreen margin (index.ts). */
  marginHost?: FullscreenMarginHost;
  historyWindowHost?: HistoryWindowHost;
}

/** Bounded store for completed write diffs (entry + total budget). */
const MAX_WRITE_CHANGES = 64;

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
  const content = normalizeMessageBlocks(record.content);
  return {
    role,
    content,
    stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
  };
}

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
  let chromeEnabled = false;
  let startupWarningFilter: ReturnType<typeof installStartupWarningFilter> | undefined;
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

  // Chrome install state + lifecycle (src/chrome/install.ts). `chrome.state`
  // is read by diagnostics and events; every chrome mutation goes through it.
  const chrome = createChromeLifecycle({
    config,
    hostData,
    colorLevel: session.colorLevel,
    editorHost: bindings.editorHost,
    surface: bindings.surface,
    appearanceVersion: bindings.appearanceVersion,
    piVersion: bindings.piVersion,
    // snapshots is built after metrics (which needs chrome.state), so the
    // lifecycle reads it lazily — it only installs after session_start.
    getSnapshots: () => snapshots,
    requestRender,
    captureTui,
    selectionCopyHook: () => (config.selectionCopy.ctrlC ? selectionCopy?.editorHook() : undefined),
    isInteractionActive: () => metrics.active,
  });

  const selectionCopy: SelectionCopySystem | undefined = bindings.selectionCopyHost && config.enabled && config.selectionCopy.enabled
    ? createSelectionCopySystem(bindings.selectionCopyHost, undefined)
    : undefined;
  if (selectionCopy) {
    const wrap = selectionCopy.wrapPrototypes();
    if (!wrap.installed) {
      // Wrapping failed: keep native copy semantics, no half-applied state.
      process.stderr.write(`metis-pi: selection-copy prototypes unavailable (${wrap.details})\n`);
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
  function requestRender(): void {
    try {
      chrome.state.tui?.requestRender?.();
    } catch { /* render happens on the next host cycle */ }
  }

  // Working-tree change counts for the footer: display-only git reads on a 2s
  // poll plus activity-driven refreshes (agent ticks, tool work), armed only
  // while a TUI footer actually displays them (see git-changes.ts).
  const gitChanges = createGitChangesTracker({
    getCwd: () => hostData.getCwd(),
    onUpdate: requestRender,
  });

  // The factory-time tui is the only reliable requestRender source. Prototype
  // installs retry on every capture and agent activity — the captured
  // renderer may still be the main screen at first (owner-symbol idempotent).
  let serializerHost: unknown = undefined;
  function captureTui(tui: unknown): void {
    if (!tui || typeof tui !== "object") return;
    if (!chrome.state.tui) {
      const rr = (tui as { requestRender?: unknown }).requestRender;
      if (typeof rr === "function") chrome.state.tui = tui as { requestRender?: () => void };
    }
    serializerHost ??= tui;
    if (selectionCopy) selectionCopy.installOnTui(serializerHost);
    fullscreenMargin?.installOnTui(tui);
    glyphPresentation?.installOnTui(tui);
    historyWindow?.installOnTui(tui);
  }

  const metrics = new UiMetrics(
    { now: () => performance.now(), wall: () => Date.now() },
    {
      onTick: (snapshot) => {
        if (!chromeEnabled) return;
        // Activity signal for the footer's change counts: refresh while the
        // agent works, so an edit lands in the footer in ~debounce time
        // instead of waiting for the next poll.
        gitChanges.touch();
        if (chrome.state.widgetInstalled) {
          // The widget component reads the snapshot at render; a 1s tick just
          // asks the host for a frame. No per-token reinstalls.
          requestRender();
          return;
        }
        if (chrome.state.fallbackMessage && config.working.elapsed) {
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
        chrome.state.workingComponent?.stopAnimation();
        chrome.setWidgetVisible(false);
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
  const snapshots = createSnapshotSource({
    getConfig: () => config,
    hostData,
    ledger,
    metrics,
    outputSpeed,
    gitChanges,
  });
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

  pi.on("session_start", (_event, ctx) => {
    const full = ctx as unknown as HostContextLike & { hasUI?: boolean; ui?: Record<string, unknown> };
    chrome.invalidate();
    hostData.bind(full);
    ledger.rebuild(hostData.getSessionEntries());
    outcome.reset();
    // One capability snapshot per session, from the same live ctx.ui that
    // chrome.install captures below.
    const available = hostData.available;
    enabled = hostData.isTui || hostData.hasUI;
    // Chrome/metrics/summary side effects only in the REAL TUI process and
    // only while enabled — print/json/rpc never get timers or ANSI.
    chromeEnabled = hostData.isTui && config.enabled !== false;
    startupWarningFilter?.dispose();
    startupWarningFilter = chromeEnabled ? installStartupWarningFilter() : undefined;
    gitChanges.dispose();
    if (chromeEnabled) {
      const generation = chrome.state.generation;
      void chrome.install(available, generation).then(() => {
        // Wait for a successful footer install; neither a hidden changes
        // segment nor a late install from a disposed session needs a poller.
        if (generation === chrome.state.generation && chromeEnabled
          && config.footer.showChanges && chrome.state.footerInstalled && hostData.getCwd()) gitChanges.start();
      });
    }
    if (!enabled || handle?.installed) return;
    handle = installAdapter(bindings.prototype, {
      getTools: () => pi.getAllTools(), enabled: () => enabled,
      renderers: makeRenderers(bindings.makeText, bindings.expandHint, bindings.highlight, bindings.makeDiff, bindings.makeShell, bindings.makeWriteCall, session, bindings.layoutOps),
      ownedApplyPatch: bindings.makeDiff ? createOwnedApplyPatchView(bindings.makeText, bindings.makeDiff, bindings.expandHint) : undefined,
      highlightOwnedCommand: (lines) => highlightBashScript(lines, session.colorLevel),
      renderOwnedCommand: bindings.makeShell?.makeShellCall
        ? (command, state, expanded, theme, context) => bindings.makeShell!.makeShellCall!({
          name: "bash", args: { command }, options: { expanded }, theme, context,
          bullet: theme.fg("dim", "•"), title: state === "running" ? "Running" : "Ran",
          expandHint: bindings.expandHint(), colorLevel: session.colorLevel,
        })
        : undefined,
    });
    if (!handle.installed) ctx.ui.notify(`metis-pi: ${handle.reason}. Compact transcript was not installed.`, "warning");
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
        thinkingPolicy,
        makeThoughtSummary: bindings.makeThoughtSummary,
        isCollapsedLabel: bindings.isCollapsedLabel,
        enabled: () => enabled,
      });
      const failedFeatures = decorations.features.filter((f) => !f.installed);
      if (failedFeatures.length) {
        const detail = failedFeatures.map((f) => `${f.name}: ${f.reason}`).join("; ");
        ctx.ui.notify(`metis-pi: decorations partially unavailable (${detail}).`, "warning");
      }
    }
  });

  registerDiagnosticsCommand({
    api: bindings.api,
    appearanceVersion: bindings.appearanceVersion,
    piVersion: bindings.piVersion,
    getConfig: () => config,
    chrome: chrome.state,
    hostData,
    metrics,
    outcome,
    ledger,
    outputSpeed,
    gitChanges,
    selectionCopy,
    fullscreenMargin,
    historyWindow,
    glyphPresentation,
    getHandle: () => handle,
    getDecorations: () => decorations,
    hasSurfaceBinding: bindings.surface !== undefined,
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
  pi.on("agent_start", () => {
    hostData.bump();
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
    chrome.setWidgetVisible(true);
  });
  pi.on("agent_end", () => {
    hostData.bump();
    if (!chromeEnabled) return;
    metrics.agentEnd();
  });
  pi.on("agent_settled", () => {
    hostData.bump();
    if (!chromeEnabled) return;
    metrics.agentSettled();
    outcome.reset();
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
    hostData.bump();
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
    hostData.bump();
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
    hostData.bump();
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
        const identified = usageKeyOf(record);
        const key = identified?.key ?? `u-${Math.random().toString(36).slice(2)}`;
        metrics.recordUsage(key, sanitizeUsage(usage), identified ? identified.identified : false);
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
    startupWarningFilter?.dispose();
    startupWarningFilter = undefined;
    chrome.invalidate();
    handle?.dispose();
    handle = undefined;
    decorations?.dispose();
    decorations = undefined;
    historyWindow?.dispose();
    fullscreenMargin?.dispose();
    // Chrome restore: only OUR factories are removed (identity comparison);
    // a successor extension's editor/footer/header is left untouched.
    chrome.restore();
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
