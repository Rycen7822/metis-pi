import { installAdapter, type AdapterHandle } from "./adapter.ts";
import { installTranscriptDecorations, type DecorationHandle } from "./transcript-adapter.ts";
import { TranscriptState, type TranscriptEvent } from "./transcript-state.ts";
import { makeRenderers, type TextFactory, type Highlight, type DiffFactory, type ShellFactories } from "./renderers.ts";
import { WriteDiffTracker, resolveWritePath, type WriteDiff } from "./write-tracker.ts";
import { detectColorLevel, type ColorLevel } from "./palette.ts";
import { UiMetrics, WORKING_PHASE_LABEL, formatDuration } from "./ui-metrics.ts";
import { TurnSummary } from "./turn-summary.ts";
import { probeHost, type HostFacts, type ResourceCounters } from "./host-compat.ts";
import { loadConfig, type AppearanceConfig } from "./config.ts";

export interface AppearanceAPI {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, context: {
    hasUI: boolean; ui: { notify(text: string, level: "warning"): void };
  }) => void): void;
  on(event: "tool_execution_start", handler: (event: { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }, context: { cwd: string }) => void): void;
  on(event: "tool_execution_end", handler: (event: { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }, context: { cwd: string }) => void): void;
  on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  on(event: "agent_start" | "agent_settled" | "agent_end", handler: (event: { type: string }, context: unknown) => void): void;
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

  /** Format the collapsed-thinking label with the measured duration. */
  /** Host CustomEditor class for the chrome editor factory (index.ts only). */
  editorHost?: { CustomEditor: unknown };
  // ---- 0.8.0 chrome bindings (public host APIs; resolved in index.ts) ----
  /** The full ExtensionAPI object (for appendEntry / registerEntryRenderer / registerCommand). */
  api?: unknown;
  /** Host extension context captured at session_start (mode/hasUI/ui/model/cwd). */
  onContext?: (context: AppearanceHostContext) => void;
  /** Read the agent config dir (host getAgentDir or ~/.pi/agent). */
  getAgentDir?: () => string | undefined;
  /** Read a file (config loading; injected to keep tests filesystem-free). */
  readFile?: (path: string) => string | undefined;
}

export interface AppearanceHostContext {
  mode: string;
  hasUI: boolean;
  model?: { label: string; effort?: string } | undefined;
  cwd: string;
  ui: {
    setEditorComponent?: (factory: unknown) => void;
    getEditorComponent?: () => unknown;
    setFooter?: (factory: unknown) => void;
    setHeader?: (factory: unknown) => void;
    setWidget?: (key: string, content: unknown, options?: unknown) => void;
    setWorkingMessage?: (message?: string) => void;
    setWorkingVisible?: (visible: boolean) => void;
    setWorkingIndicator?: (options?: unknown) => void;
    getContextUsage?: () => { percentUsed?: number; input?: number; capacity?: number } | undefined;
    requestRender?: () => void;
    notify?: (text: string, level?: string) => void;
  };
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

/** Normalize the host model snapshot into the footer's display shape. */
function normalizeModel(model: unknown): { label: string; effort?: string } | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  const label = typeof record.label === "string" && record.label
    ? record.label
    : typeof record.displayName === "string" && record.displayName ? record.displayName : undefined;
  if (!label) return undefined;
  const effort = typeof record.effort === "string" && record.effort ? record.effort : undefined;
  return { label, effort };
}

export function activate(pi: AppearanceAPI, bindings: Bindings): void {
  let enabled = false;
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

  // ---- 0.8.0 chrome/metrics state -----------------------------------------
  const counters: ResourceCounters = { timers: 0, subscriptions: 0, widgets: 0, pendingBounded: 0, snapshot() { return { timers: this.timers, subscriptions: this.subscriptions, widgets: this.widgets, pendingBounded: this.pendingBounded }; } };
  let hostContext: AppearanceHostContext | undefined;
  let config: AppearanceConfig = loadConfig(bindings.getAgentDir?.(), bindings.readFile).config;
  const metrics = new UiMetrics(
    { now: () => performance.now(), wall: () => Date.now() },
    {
      onTick: (snapshot) => {
        if (!hostContext || !config.working.elapsed) return;
        const label = WORKING_PHASE_LABEL[snapshot.phase];
        hostContext.ui.setWorkingMessage?.(`${label} · ${formatDuration(snapshot.elapsedMs)}`);
      },
      onSettled: (snapshot) => {
        hostContext?.ui.setWorkingMessage?.();
        if (config.summary.enabled) {
          const outcome = lastRunFailed ? "failed" : lastRunInterrupted ? "interrupted" : "completed";
          turnSummary.record(snapshot, outcome);
        }
        lastRunFailed = false;
        lastRunInterrupted = false;
      },
    },
  );
  let ourEditorFactory: object | undefined;
  let lastRunFailed = false;
  let lastRunInterrupted = false;
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

  // ---- lifecycle ------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    const full = ctx as unknown as { mode?: string; hasUI?: boolean; model?: unknown; cwd?: string; ui?: AppearanceHostContext["ui"] };
    hostContext = {
      mode: typeof full.mode === "string" ? full.mode : (full.hasUI ? "tui" : "unknown"),
      hasUI: full.hasUI === true,
      cwd: typeof full.cwd === "string" ? full.cwd : "",
      model: normalizeModel(full.model),
      ui: (full.ui ?? {}) as AppearanceHostContext["ui"],
    };
    bindings.onContext?.(hostContext);
    const facts: HostFacts = probeHost({ ui: hostContext.ui as never, mode: hostContext.mode, hasUI: hostContext.hasUI });
    enabled = facts.isTui || ctx.hasUI;
    // Chrome (editor/footer/header/working) only in the REAL TUI process.
    if (facts.isTui) {
      installChrome(facts);
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

  // /codex-ui — capability diagnostics (3.3): one line per feature with the
  // real cause; never hides partial failure behind a single reason.
  // Host signature: registerCommand(name, { description, handler }).
  (bindings.api as { registerCommand?: (name: string, options: unknown) => void } | undefined)?.registerCommand?.("codex-ui", {
    description: "pi-codex-appearance capability diagnostics",
    handler: (args: string, commandCtx: { ui?: { notify?: (text: string) => void } }) => {
      let text: string;
      if (!hostContext) {
        text = "pi-codex-appearance: no active session";
      } else {
        const facts = probeHost({ ui: hostContext.ui as never, mode: hostContext.mode, hasUI: hostContext.hasUI });
        const chrome = config.enabled === false ? "disabled(config)" : facts.isTui ? "applied" : "unsupported (not a TUI session)";
        const transcript = handle?.installed ? "applied" : handle ? `failed: ${handle.reason}` : "not installed";
        const decor = decorations
          ? decorations.features.map((f) => `${f.name}=${f.installed ? "applied" : `failed: ${f.reason}`}`).join(", ")
          : "unavailable (no assistant prototype binding)";
        const clock = metrics.snapshot();
        const think = config.thinking;
        const wp = config.writePreview;
        const lines = [
          "pi-codex-appearance 0.8.1 diagnostics:",
          `  chrome:  ${chrome}`,
          `  transcript: ${transcript}`,
          `  decorations: ${decor}`,
          `  interaction clock: ${clock.active ? `open ${Math.round(clock.elapsedMs / 1000)}s` : "idle"} (timers=${counters.timers})`,
          `  config: thinking=${think.streaming}/${think.completed} rail=${think.rail ? "on" : "off"} writePreview=${wp.enabled ? `${wp.rows} rows` : "off"}`,
        ];
        text = lines.join("\n");
      }
      // Return values are ignored by the host; surface via the command ctx.
      commandCtx?.ui?.notify?.(text);
    },
  });

  /** Install the Codex-style chrome through PUBLIC host APIs only. Each slot
   * is tracked by factory identity so restore never removes a successor's
   * component. */
  function installChrome(facts: HostFacts): void {
    const ui = hostContext?.ui;
    if (!ui) return;
    if (config.enabled === false) return;

    // Working indicator: static dot, we drive the MESSAGE text (with elapsed)
    // from the metrics ticker. One status position — the native indicator row.
    if (facts.available.setWorkingIndicator) {
      try {
        ui.setWorkingIndicator?.({ frames: ["●"], intervalMs: 1000 });
      } catch { /* native spinner keeps its default */ }
    }

    // Editor factory: Codex-look composer through the host's custom-editor
    // hook. Identity-tracked: on restore we compare factory identity and only
    // clear the slot when the CURRENT factory is still ours (a successor
    // extension's editor is never removed).
    if (facts.available.setEditorComponent && !ui.getEditorComponent?.() && bindings.editorHost?.CustomEditor) {
      try {
        void import("./chrome/editor.ts").then(({ makeCodexEditorFactory }) => {
          const factory = makeCodexEditorFactory({
            host: bindings.editorHost as never,
            paddingX: 2,
            embedWorkingStatus: true,
          });
          ourEditorFactory = factory;
          ui.setEditorComponent?.(factory as never);
        });
      } catch { /* editor stays native */ }
    }

    // Footer factory (model · effort · cwd/branch — context right).
    if (facts.available.setFooter) {
      try {
        void import("./chrome/footer.ts").then(({ createFooterComponent }) => {
          ui.setFooter?.((tui: unknown, theme: { fg?: (k: string, t: string) => string }, footerData: unknown) =>
            createFooterComponent(
              {
                getContextUsage: () => hostContext?.ui.getContextUsage?.(),
                getModel: () => hostContext?.model,
                getCwd: () => hostContext?.cwd ?? "",
                requestRender: () => hostContext?.ui.requestRender?.(),
              },
              footerData as never,
              theme,
            ));
        });
      } catch { /* footer stays native */ }
    }

    // Header factory (real identity line).
    if (facts.available.setHeader) {
      try {
        void import("./chrome/header.ts").then(({ createHeaderComponent }) => {
          ui.setHeader?.((_tui: unknown, theme: { fg?: (k: string, t: string) => string } | undefined) =>
            createHeaderComponent(
              {
                appearanceVersion: "0.8.3",
                piVersion: "0.85.1",
                getModel: () => hostContext?.model,
                getCwd: () => hostContext?.cwd ?? "",
              },
              theme,
            ));
        });
      } catch { /* header stays native */ }
    }
    void counters;
  }

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

  // Write tracking observes lifecycle events only (never tool_call/tool_result
  // content). Reads the local file for an honest pre/post image; all state is
  // ephemeral presentation data dropped at session shutdown.
  // Interaction clock: opens on the first agent_start of a chain, closes on
  // agent_settled (auto-retry/compaction/queued follow-ups never reset it).
  (pi as unknown as AppearanceAPI).on("agent_start", () => {
    metrics.agentStart();
  });
  (pi as unknown as AppearanceAPI).on("agent_settled", () => {
    metrics.agentSettled();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (!enabled) return;
    const info = sourceInfoFor(event.toolName);
    session.tracker.trackStart(event.toolCallId, event.toolName, event.args, info, (path) => resolveWritePath(path, ctx.cwd));
    // Transcript projection: exploration grouping + separator boundary.
    transcript.apply({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName });
    metrics.toolStart();
    if (event.toolName === "write") metrics.writeStreaming();
  });
  pi.on("tool_execution_end", (event) => {
    if (!enabled) return;
    if (event.isError === true) lastRunFailed = true;
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
  });
  // Wire the real message handlers (typed loosely above to avoid importing
  // host event types; only read-only content-shape fields are read). The
  // event's message OBJECT is passed as the identity anchor (0.8.0 fix) so
  // the state machine can key plans by the host's own object identity.
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_start", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    transcript.apply({ type: "message_start", message: toStateMessage(message) }, message);
    if (isUserMessage(message)) metrics.uiPromptEnd();
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_update", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    const stateMessage = toStateMessage(message);
    transcript.apply({ type: "message_update", message: stateMessage }, message);
    // Phase feed for the Working line (0.8.1 fix): the CURRENT streaming
    // event decides the phase — never the accumulated content. An old
    // thinking block staying in the message must NOT keep "Thinking" lit
    // while the model is streaming a write tool call's arguments.
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
  });
  (pi as unknown as {
    on(event: "message_start" | "message_update" | "message_end", handler: (event: { type: string; message?: unknown }) => void): void;
  }).on("message_end", (event) => {
    if (!enabled) return;
    const message = event.message as object | undefined;
    const stateMessage = toStateMessage(message);
    transcript.apply({ type: "message_end", message: stateMessage }, message);
    metrics.thinkingEnd();
    if (stateMessage?.stopReason === "aborted") lastRunInterrupted = true;
    // Usage totals (read-only): the assistant message carries the provider
    // usage. requestKey = responseId (stable across replays).
    if (message && typeof message === "object") {
      const record = message as Record<string, unknown>;
      const usage = record.usage as Record<string, number> | undefined;
      if (usage) {
        const key = typeof record.responseId === "string" && record.responseId
          ? record.responseId
          : `m-${record.timestamp ?? record.id ?? metrics.generation}`;
        metrics.recordUsage(key, usage);
      }
    }
  });
  pi.on("session_shutdown", () => {
    enabled = false;
    handle?.dispose();
    handle = undefined;
    decorations?.dispose();
    decorations = undefined;
    // Chrome restore: only OUR factories are removed (identity comparison);
    // a successor extension's editor/footer/header is left untouched.
    const ui = hostContext?.ui;
    if (ui) {
      try {
        if (ourEditorFactory && ui.getEditorComponent?.() === ourEditorFactory) {
          ui.setEditorComponent?.(undefined);
        }
      } catch { /* keep current editor */ }
      ourEditorFactory = undefined;
      ui.setFooter?.(undefined as never);
      ui.setHeader?.(undefined as never);
      ui.setWorkingMessage?.();
    }
    session.writeChanges.clear();
    session.resultImages.clear();
    transcript.resetSession();
    metrics.reset();
    turnSummary.forgetSession();
  });
}

function isUserMessage(message: unknown): boolean {
  return (message as Record<string, unknown> | undefined)?.role === "user";
}
