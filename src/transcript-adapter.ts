// Transcript decoration: one assistant decoration layer coordinates the
// separator line, the thinking rail, the thinking visibility policy and the
// collapsed-run summary labels against the rebuilt contentContainer (they
// must not stack two unaware patches on the same updateContent).
//
// Coordination contract: call the approved predecessor exactly ONCE, read the
// REBUILT subtree, map text/thinking slots semantically, then re-attach the
// decorations the current subtree needs. "Idempotent" means exactly one
// matching decoration in the CURRENT subtree — removed-by-clear() decorations
// are re-attached.
//
// Thinking visibility policy: the host owns hidden-vs-expanded rendering, the
// MouseRegion click toggle and the override map (`thinkingVisibilityOverrides`
// on the component instance). The policy writes that map AT MOST ONCE per
// lifecycle transition (run becomes active / run becomes ended) and NEVER
// fights a later manual toggle or a Ctrl+T global toggle (whose
// setHideThinkingBlock clears the map — already-applied transitions are
// remembered per component and never re-applied). The expanded Markdown body
// is never rewritten into a label; the collapsed side only swaps the host's
// own label Text inside its MouseRegion for a duration summary.
//
// External owner awareness: an external wrapper (e.g. pi-zentui thinkingSteps)
// may already own assistant thinking display; when detected the rail stays
// passive while the separator stays active.

import { asRecord } from "./tool-names.ts";
import { TranscriptState, normalizeMessageBlocks, semanticRuns, type SemanticRun, type MessageViewKey } from "./transcript-state.ts";
import { createThinkingViewControl, type ThinkingView, type ThinkingViewControl } from "./thinking-view.ts";

const ASSISTANT_SLOT = Symbol.for("Rycen7822.metis-pi.assistant-deco.v2");
const THOUGHT_LABEL = Symbol.for("Rycen7822.metis-pi.thought-label.v1");
const CLICK_SYMBOL = Symbol.for("Rycen7822.metis-pi.thinking-click.v1");

/** Per-feature install diagnostics (never aggregate with .some()). */
export interface DecorationFeature {
  readonly name: "separator" | "thinking-rail" | "thinking-policy";
  readonly installed: boolean;
  readonly reason: string;
}

export interface DecorationHandle {
  readonly features: readonly DecorationFeature[];
  readonly thinkingAutoApplied: () => number;
  dispose(): void;
}

export interface ThinkingPolicy {
  streaming: "peek" | "full" | "collapsed";
  completed: "full" | "collapsed";
  /** Rows visible in the peek window (config already clamped it). */
  peekLines: number;
}

export interface TranscriptAdapterInput {
  state: TranscriptState;
  assistantPrototype: object | undefined;
  /** Build the separator line component (width-aware at render time). */
  makeSeparator: () => unknown;
  /** Build a native spacer so assistant subtree matching can identify its class. */
  makeSpacer: () => unknown;
  /**
   * Wrap a thinking display node with our rail. Returns undefined when the
   * host shape is not supported (the caller then leaves the node untouched).
   */
  makeRail: ((child: unknown) => unknown) | undefined;
  /**
   * Wrap a thinking body so left clicks toggle collapsed/peek and right clicks
   * toggle full/collapsed. Full ignores left clicks. Applied OUTSIDE the rail.
   */
  makeClickable?: (input: {
    inner: unknown;
    /** Existing adjacent spacers moved inside the hit area, without adding rows. */
    before?: unknown;
    after?: unknown;
    control: ThinkingViewControl;
    fallback: ThinkingView;
    apply: (next: ThinkingView) => void;
  }) => unknown;
  /**
   * Wrap a thinking body in the peek window (newest `windowLines` rows, wheel
   * scrollable). Applied INSIDE the rail, so clipped rows keep the rail and the
   * hint row reads as part of the same block.
   */
  makePeek?: (input: {
    inner: unknown;
    control: ThinkingViewControl;
    windowLines: number;
    /** Ask the host for the rebuild that repaints a scrolled window — the host
     * repaints through its own update path, not through a bare requestRender. */
    onScroll: () => void;
  }) => unknown;
  /**
   * Thinking display policy (config). When absent, NO automatic visibility
   * transition is ever applied — the host's own defaults stay in charge.
   */
  thinkingPolicy?(): ThinkingPolicy;
  /**
   * Build the collapsed-run summary label ("Thought for 13s") as a display-only
   * component. Only ever used to replace the host's OWN collapsed label Text
   * inside its MouseRegion; never applied to an expanded Markdown body.
   */
  makeThoughtSummary?: (input: {
    durationMs?: number;
    runIndex: number;
    ended: boolean;
    paddingX: number;
    paint?: (text: string) => string;
  }) => unknown;
  /**
   * Structural guard: is this node the host's collapsed-label Text? Must be a
   * real class/shape check from the host (e.g. `instanceof Tui.Text`) — never
   * a `.text` field sniff.
   */
  isCollapsedLabel?: (node: unknown) => boolean;
  enabled(): boolean;
  /** Repaint after a coalesced streaming preview; gestures/finals stay immediate. */
  requestRender?(): void;
}

const RAIL_SYMBOL = Symbol.for("Rycen7822.metis-pi.thinking-rail");
const PEEK_SYMBOL = Symbol.for("Rycen7822.metis-pi.thinking-peek");
const SEP_SYMBOL = Symbol.for("Rycen7822.metis-pi.separator");

export function installTranscriptDecorations(input: TranscriptAdapterInput): DecorationHandle {
  const features: DecorationFeature[] = [];
  const disposers: Array<() => void> = [];
  const autoApplied = { count: 0 };
  if (input.assistantPrototype) {
    const result = decorateAssistant(input, autoApplied);
    features.push(
      { name: "separator", installed: result.installed, reason: result.reason },
      { name: "thinking-rail", installed: result.railInstalled, reason: result.railReason },
      {
        name: "thinking-policy",
        installed: result.installed && input.thinkingPolicy !== undefined,
        reason: !result.installed
          ? "assistant decoration unavailable"
          : input.thinkingPolicy !== undefined
            ? input.makeThoughtSummary && input.isCollapsedLabel
              ? "auto-collapse + duration labels enabled"
              : "auto-collapse enabled; duration labels unavailable (no summary factory)"
            : "no policy binding — host defaults stay in charge",
      },
    );
    if (result.installed || result.railInstalled) disposers.push(result.dispose);
  }
  return { features, thinkingAutoApplied: () => autoApplied.count, dispose() { for (const d of disposers) d(); } };
}

// Assistant subtree: separator before the first text run, rail on expanded
// thinking runs, auto visibility policy + duration labels on collapsed ones —
// re-coordinated after EVERY rebuild.
function decorateAssistant(input: TranscriptAdapterInput, autoApplied: { count: number }): {
  installed: boolean; reason: string;
  railInstalled: boolean; railReason: string;
  dispose: () => void;
} {
  const prototype = input.assistantPrototype!;
  const key = "updateContent";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return {
      installed: false,
      reason: "Pi updateContent missing or read-only",
      railInstalled: false,
      railReason: "no updateContent access",
      dispose: () => {},
    };
  }
  // Structural contract: the method exists, is writable/configurable, and the
  // rebuilt subtree exposes the host's contentContainer. String fingerprints
  // are deliberately NOT used — comments, minification or benign patches
  // (e.g. zentui's wrapper) must not block installation.
  const original = descriptor.value as (this: unknown, ...args: unknown[]) => void;
  const owner = {};

  // zentui's thinking wrapper may chain on the same method. Ownership is per
  // descriptor, so chain order works either way: an outer wrapper installed
  // after ours is kept by our dispose (this layer goes transparent), and a
  // wrapper installed before us is captured as the descriptor we decorate.
  let active = true;

  // A view change needs the host to rebuild this component's subtree. The
  // host's own MouseRegion handler does exactly this (updateContent(lastMessage)),
  // so a click behaves like the native toggle it replaces.
  const rebuild = (target: object): void => {
    try {
      if (!active) return;
      const record = target as { updateContent?: (message: unknown) => void; lastMessage?: unknown };
      if (record.lastMessage !== undefined) record.updateContent?.(record.lastMessage);
    } catch { /* a presentation failure must not break the message */ }
  };

  // Auto policy state: applied transitions are remembered PER COMPONENT and
  // PER RUN so the policy fires once per lifecycle transition — never on every
  // repaint. This is what keeps manual toggles and Ctrl+T sticky.
  const appliedPhases = new WeakMap<object, Map<number, "streaming" | "completed">>();

  // The spacer prototype is stable for the session — build one probe spacer
  // lazily instead of allocating one per rebuild.
  let spacerProto: object | undefined;
  let spacerProtoKnown = false;
  const getSpacerProto = (): object | undefined => {
    if (!spacerProtoKnown) {
      spacerProtoKnown = true;
      spacerProto = input.makeSpacer ? Object.getPrototypeOf(input.makeSpacer()) : undefined;
    }
    return spacerProto;
  };

  type PreviewUpdate = {
    at: number; messageKey?: MessageViewKey; readyPeek?: boolean; flushing?: boolean;
    args?: unknown[]; timer?: ReturnType<typeof setTimeout>;
  };
  const previews = new WeakMap<object, PreviewUpdate>();
  const pending = new Set<PreviewUpdate>();
  const releasePreview = (preview: PreviewUpdate): void => {
    clearTimeout(preview.timer);
    preview.args = undefined;
    preview.timer = undefined;
    pending.delete(preview);
  };
  const wrapper = function (this: unknown, ...args: unknown[]): void {
    const target = typeof this === "object" && this !== null ? this : undefined;
    const preview = target ? previews.get(target) : undefined;
    let canPreview = false;
    try { canPreview = active && input.requestRender !== undefined && input.enabled(); }
    catch { /* Optional cadence must not prevent the native rebuild. */ }
    // SDK deltas are fresh shallow copies; event-anchored keys identify the
    // logical response. Without that evidence, keep the native update immediate.
    const messageKey = canPreview && target && typeof args[0] === "object" && args[0] !== null
      ? input.state.identityOf(args[0]) : undefined;
    if (canPreview && target) {
      const content = asRecord(args[0]).content;
      let policy: ThinkingPolicy | undefined;
      try { policy = input.thinkingPolicy?.(); }
      catch { /* Keep the ordinary immediate host/presentation fallback. */ }
      // Only a mounted peek bound to persistent run state can coalesce.
      // Manual rebuilds, mixed/foreign content and completion stay immediate.
      const longPeek = args[1] === true && preview?.readyPeek === true && !preview.flushing
        && messageKey !== undefined && preview.messageKey === messageKey && policy?.streaming === "peek"
        && Array.isArray(content) && content.length > 0 && content.every(block => asRecord(block).type === "thinking")
        && content.reduce((sum, block) => sum + String(asRecord(block).thinking ?? "").length, 0) >= 16_384;
      const delay = preview ? Math.min(100, 100 - (Date.now() - preview.at)) : 0;
      if (longPeek && preview && delay > 0) {
        preview.args = args;
        Reflect.set(target, "lastMessage", args[0]);
        Reflect.set(target, "isStreaming", true);
        if (!preview.timer) {
          const queued = preview;
          queued.timer = setTimeout(() => {
            const latest = queued.args;
            releasePreview(queued);
            try {
              // A queued old partial must never replace a newer native owner.
              if (!latest || !active || !input.enabled() || asRecord(target).lastMessage !== latest[0]) return;
              // Visit the current wrapper chain once, bypassing this queue
              // explicitly rather than encoding flush state in a timestamp.
              queued.flushing = true;
              const refresh = asRecord(target).updateContent;
              if (typeof refresh === "function") refresh.apply(target, latest);
              input.requestRender?.();
            } catch { /* An optional presentation callback must not escape a timer. */ }
            finally { queued.flushing = false; }
          }, delay);
          queued.timer.unref?.();
          pending.add(queued);
        }
        return;
      }
    }
    if (preview) { releasePreview(preview); preview.readyPeek = false; }
    original.apply(this, args);
    // Only a successful native rebuild starts a cadence window. The logical
    // key changes on component reuse/session reset without retaining payloads.
    if (canPreview && target) {
      const current = preview ?? { at: 0 };
      current.at = Date.now();
      current.messageKey = messageKey;
      previews.set(target, current);
    }
    if (!active || !input.enabled() || typeof this !== "object" || this === null) return;
    let view: AssistantView | undefined;
    try { view = readAssistantView(input, this); } catch { return; }
    if (!view) return;
    try {
      // A visibility transition needs the host to REBUILD so the run renders
      // under its new hidden state. Call the CAPTURED original (never
      // this.updateContent — no wrapper recursion), at most ONE extra rebuild,
      // only when the override map actually changed.
      if (input.thinkingPolicy && applyThinkingPolicy(input, view, appliedPhases, autoApplied)) {
        original.apply(this, args);
      }
    } catch {
      // A policy failure must not break the original message display.
    }
    try {
      const readyPeek = coordinateSubtree(input, view, getSpacerProto(), rebuild);
      const preview = previews.get(this);
      if (preview) preview.readyPeek = readyPeek;
    } catch {
      // A presentation failure must not break the original message display.
    }
  };

  try {
    Object.defineProperty(prototype, ASSISTANT_SLOT, { value: owner, configurable: true });
    Object.defineProperty(prototype, key, { ...descriptor, value: wrapper });
  } catch {
    return {
      installed: false,
      reason: "Pi assistant prototype cannot be decorated",
      railInstalled: false,
      railReason: "cannot decorate",
      dispose() {},
    };
  }
  return {
    installed: true,
    reason: "assistant decoration layer enabled",
    railInstalled: input.makeRail !== undefined,
    railReason: input.makeRail !== undefined ? "thinking rail enabled" : "no rail factory provided",
    dispose() {
      active = false;
      for (const update of pending) releasePreview(update);
      try {
        if (Object.getOwnPropertyDescriptor(prototype, key)?.value === wrapper) {
          Object.defineProperty(prototype, key, descriptor);
        }
        if (Object.getOwnPropertyDescriptor(prototype, ASSISTANT_SLOT)?.value === owner) {
          Reflect.deleteProperty(prototype, ASSISTANT_SLOT);
        }
      } catch { /* frozen prototype keeps an inert wrapper */ }
    },
  };
}

interface AssistantView {
  component: Record<string, unknown>;
  planKey: MessageViewKey | undefined;
  runs: SemanticRun[];
}

/** Resolve identity and semantic content once per host rebuild; both policy and decoration use it. */
function readAssistantView(input: TranscriptAdapterInput, component: object): AssistantView | undefined {
  const record = asRecord(component);
  const message = asRecord(record.lastMessage);
  if (message.role !== "assistant") return undefined;
  const content = normalizeMessageBlocks(message.content);
  return { component: record, planKey: resolveMessagePlan(input, component, message, content), runs: semanticRuns(content) };
}

/**
 * Apply the thinking visibility policy to the host's override map. Each
 * transition (a run first renders while active; a run becomes ended) is
 * applied AT MOST ONCE per (component, run) — later manual toggles and
 * Ctrl+T's map-clearing setHideThinkingBlock are never fought. The completed
 * policy only FORCES a run open when a plugin/user override entry already
 * exists; a run hidden solely by the host's global hideThinkingBlock stays
 * hidden. Returns true when the map changed and the host must rebuild once.
 */
function applyThinkingPolicy(
  input: TranscriptAdapterInput,
  { component: record, planKey: key, runs }: AssistantView,
  appliedPhases: WeakMap<object, Map<number, "streaming" | "completed">>,
  autoApplied: { count: number },
): boolean {
  const overrides = record.thinkingVisibilityOverrides;
  if (!overrides || typeof (overrides as Map<number, boolean>).get !== "function" || typeof (overrides as Map<number, boolean>).set !== "function") {
    return false; // host shape changed — native visibility stays in charge
  }
  const map = overrides as Map<number, boolean>;
  const policy = input.thinkingPolicy!();
  const hideAll = record.hideThinkingBlock === true;
  const apply = (runIndex: number, desired: boolean): boolean => {
    if ((map.get(runIndex) ?? hideAll) !== desired) {
      map.set(runIndex, desired);
      autoApplied.count += 1;
      return true;
    }
    return false;
  };
  let changed = false;
  let phases = appliedPhases.get(record);
  if (!phases) appliedPhases.set(record, (phases = new Map()));
  for (const run of runs) {
    const runIndex = run.thinkingRunIndex;
    if (runIndex === undefined) continue;
    const plan = key !== undefined ? input.state.thinkingRunPlan(key, runIndex) : undefined;
    const ended = plan ? plan.ended : run.ended === true;
    // Per-run display state (click choice + peek scroll), stored with the run
    // clock so every later rebuild reuses the same one.
    const control = key !== undefined
      ? input.state.thinkingViewControl(key, runIndex, createThinkingViewControl)
      : createThinkingViewControl();
    const previous = phases.get(runIndex);
    if (previous === undefined) {
      phases.set(runIndex, "streaming");
      if (!ended && apply(runIndex, policy.streaming === "collapsed")) changed = true;
    }
    // Auto-fold once; preserve manual overrides and the host's global hidden state.
    if (ended && previous !== "completed") {
      phases.set(runIndex, "completed");
      const desired = policy.completed === "collapsed";
      const forceOpen = !desired && map.has(runIndex);
      control.foldOnEnd();
      if ((desired || forceOpen) && apply(runIndex, desired)) changed = true;
    }
  }
  return changed;
}

/**
 * Re-coordinate the freshly rebuilt contentContainer: map semantic slots,
 * attach ONE separator before the first text run (when the plan says so),
 * wrap expanded thinking runs with our rail (unless an external owner did it)
 * and swap the host's collapsed labels for duration summaries.
 * Runs on every rebuild; each pass leaves exactly one matching decoration.
 */
function coordinateSubtree(
  input: TranscriptAdapterInput,
  { component: record, planKey, runs }: AssistantView,
  spacerProto: object | undefined,
  rebuild: (target: object) => void,
): boolean {
  const component = record;
  const container = asRecord(record.contentContainer);
  const children = container.children;
  if (!Array.isArray(children)) return false;
  let readyPeek = false;

  const textRunPlan = planKey !== undefined ? input.state.textRunPlan(planKey) : undefined;

  // 1) Remove OUR stale decorations from the current subtree (they get
  //    re-added below at the right slots). Components removed by clear() lose
  //    container membership but stay usable — reuse keeps identity stable.
  //    Rails are UNWRAPPED, not deleted: a MouseRegion whose inner child we
  //    wrapped keeps its click semantics; restore the original child so the
  //    decoration never rides along after dispose.
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as Record<string, unknown> | null;
    if (!child || typeof child !== "object") continue;
    if ((child as Record<symbol, unknown>)[RAIL_SYMBOL] || (child as Record<symbol, unknown>)[CLICK_SYMBOL]
      || (child as Record<symbol, unknown>)[PEEK_SYMBOL]) {
      children.splice(i, 1);
      continue;
    }
    // Rails AND thought summaries ride inside the region's child slot; both
    // remember the original so the unwrap pass can restore it — a later pass
    // (or a successor install) must re-decide from the NATIVE node, never
    // inherit a stale summary.
    const innerWrapper = (child as Record<string, unknown>).child as
      (Record<symbol | string, unknown> & { original?: unknown }) | undefined;
    if (
      innerWrapper &&
      typeof innerWrapper === "object" &&
      (innerWrapper[RAIL_SYMBOL] || innerWrapper[THOUGHT_LABEL] || innerWrapper[CLICK_SYMBOL] || innerWrapper[PEEK_SYMBOL])
    ) {
      const original = innerWrapper["original"];
      if (original !== undefined) {
        (child as { child: unknown }).child = original;
      }
    }
    if ((child as Record<symbol, unknown>)[SEP_SYMBOL]) children.splice(i, 1);
  }

  // 2) Walk the rebuilt children and match them to semantic runs. The host
  //    builds: [Spacer?] then per content order: Markdown(text) / MouseRegion
  //    (thinking) with optional Spacers between. We match by ORDER of
  //    visible children against content runs — never by string content.
  const slots = mapChildrenToRuns(children, runs, spacerProto);

  // 3) Attach the separator before the FIRST text-run slot (not message top).
  if (textRunPlan?.separatorBefore) {
    const firstTextSlot = slots.find((s) => s.run.kind === "text");
    if (firstTextSlot) {
      const separator = input.makeSeparator();
      if (separator) {
        ((separator as Record<symbol, unknown>))[SEP_SYMBOL] = true;
        const index = children.indexOf(firstTextSlot.child);
        if (index >= 0) children.splice(index, 0, separator);
      }
    }
  }

  // 4) Thinking runs. The host renders an expanded run as Markdown and a
  //    hidden run as its label Text, both inside the SAME MouseRegion.
  //    Distinguish by node shape (never by content strings). Expanded: rail
  //    only — the body is NEVER rewritten into a label. Collapsed: swap ONLY
  //    the host's own label Text for a duration summary (the region's native
  //    click handler stays; the next host rebuild restores the native label
  //    and this pass re-coordinates). An ACTIVE hidden run keeps the host's
  //    own "Thinking..." label — durations exist only for ended runs.
  const policy = input.thinkingPolicy?.();
  const viewFeature = policy !== undefined && (input.makePeek !== undefined || input.makeClickable !== undefined);
  if (input.makeRail || (input.makeThoughtSummary && input.isCollapsedLabel) || viewFeature) {
    for (const slot of slots) {
      if (slot.run.kind !== "thinking" || !slot.run.nonEmpty) continue;
      const child = slot.child as Record<string, unknown>;
      // Host shape (pi-tui MouseRegion): `child` field holds the wrapped
      // component. Swap the region's inner child in place: the region keeps
      // its own geometry.
      const inner = child && typeof child === "object" && "child" in child
        ? (child as { child: unknown }).child
        : child;
      const innerRecord = inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
      if (!inner || ((inner as Record<symbol, unknown>))[RAIL_SYMBOL]
        || ((inner as Record<symbol, unknown>))[THOUGHT_LABEL]
        || ((inner as Record<symbol, unknown>))[CLICK_SYMBOL]
        || ((inner as Record<symbol, unknown>))[PEEK_SYMBOL]) continue;

      const ordinal = slot.run.thinkingRunIndex;
      const isExpandedMarkdown = !!innerRecord && ("theme" in innerRecord || "defaultTextStyle" in innerRecord);
      const plan = ordinal !== undefined && planKey !== undefined ? input.state.thinkingRunPlan(planKey, ordinal) : undefined;
      const ended = plan ? plan.ended : slot.run.ended === true;
      const control = viewFeature && ordinal !== undefined
        ? (planKey !== undefined
          ? input.state.thinkingViewControl(planKey, ordinal, createThinkingViewControl)
          : createThinkingViewControl())
        : undefined;
      // Shape of this render: a click wins; otherwise the configured policy for
      // the run's CURRENT phase decides (a running thought peeks, a finished one
      // is folded unless completed=full). Deriving it per render is what keeps a
      // long stream honest across rebuilds — nothing stale to go wrong.
      //
      // A SHOWN run with no per-run override means the host's global default
      // shows thinking (Ctrl+T) — show everything, so that toggle keeps
      // meaning "all of it".
      const overrideShown = (record.thinkingVisibilityOverrides as Map<number, boolean> | undefined)?.get(ordinal ?? -1) === true;
      const policyDefault: ThinkingView = ended
        ? (policy?.completed === "collapsed" ? "collapsed" : "full")
        : (policy?.streaming === "peek" ? "peek" : policy?.streaming === "full" ? "full" : "collapsed");
      const derived: ThinkingView = control?.userView() ?? policyDefault;
      const view: ThinkingView = isExpandedMarkdown
        ? (derived === "collapsed" ? (overrideShown ? "peek" : "full") : derived)
        : "collapsed";

      let node: unknown = inner;
      let decorated = false, peeking = false;
      if (isExpandedMarkdown) {
        if (view === "peek" && control && input.makePeek && policy) {
          const peeked = input.makePeek({
            inner: node,
            control,
            windowLines: policy.peekLines,
            onScroll: () => rebuild(component),
          });
          if (peeked && typeof peeked === "object") {
            ((peeked as Record<symbol, unknown>))[PEEK_SYMBOL] = true;
            node = peeked;
            decorated = peeking = true;
          }
        }
        if (input.makeRail) {
          const railed = input.makeRail(node);
          if (railed && typeof railed === "object") {
            ((railed as Record<symbol, unknown>))[RAIL_SYMBOL] = true;
            node = railed;
            decorated = true;
          }
        }
      } else {
        if (!input.isCollapsedLabel?.(inner)) continue;
        if (ended && input.makeThoughtSummary) {
          const paddingX = typeof record.outputPad === "number" ? record.outputPad : 1;
          const summary = input.makeThoughtSummary({ durationMs: plan?.thinkingMs, runIndex: ordinal ?? 0, ended: true, paddingX });
          if (!summary || typeof summary !== "object") continue;
          ((summary as Record<symbol, unknown>))[THOUGHT_LABEL] = true;
          node = summary;
          decorated = true;
        }
      }

      // Include the host's existing blank rows in the hit area. Move only
      // adjacent native Spacers, never a neighboring message or separator;
      // composing them inside the click layer preserves the visible geometry.
      if (control && input.makeClickable) {
        const index = children.indexOf(child);
        const isSpacer = (node: unknown) => !!node && spacerProto !== undefined && Object.getPrototypeOf(node) === spacerProto;
        const before = index > 0 && isSpacer(children[index - 1]) ? children[index - 1] : undefined;
        const after = index >= 0 && isSpacer(children[index + 1]) ? children[index + 1] : undefined;
        const clickable = input.makeClickable({
          inner: node, before, after,
          control,
          fallback: view,
          apply: (next) => applyThinkingView(component, ordinal ?? 0, next, rebuild),
        });
        if (clickable && typeof clickable === "object") {
          if (after) children.splice(index + 1, 1);
          if (before) children.splice(index - 1, 1);
          ((clickable as Record<symbol, unknown>))[CLICK_SYMBOL] = true;
          node = clickable;
          decorated = true;
        }
      }
      if (!decorated) continue;
      // message_start can already carry a large shared partial, before a run
      // exists. Its transient control must be replaced by the first update;
      // otherwise gestures on that displayed control cannot survive rebuilds.
      readyPeek ||= peeking && plan !== undefined;
      // Remember the native node so the unwrap pass (step 1) restores it.
      (node as Record<symbol | string, unknown>)["original"] = inner;
      if (inner !== child) {
        (child as { child: unknown }).child = node;
      } else {
        const index = children.indexOf(child);
        if (index >= 0) children[index] = node;
      }
    }
  }
  return readyPeek;
}

/** Apply a user-chosen view: write the host's per-run override (the field the
 * native MouseRegion toggle writes) and ask for the ONE rebuild that renders it.
 * The view itself is already recorded in the run control. */
function applyThinkingView(component: object, runIndex: number, view: ThinkingView, rebuild: (target: object) => void): void {
  const record = component as Record<string, unknown>;
  const map = record.thinkingVisibilityOverrides as Map<number, boolean> | undefined;
  const hideAll = record.hideThinkingBlock === true;
  if (map && typeof map.get === "function" && typeof map.set === "function") {
    const hidden = view === "collapsed";
    if ((map.get(runIndex) ?? hideAll) !== hidden) map.set(runIndex, hidden);
  }
  rebuild(component);
}

function resolveMessagePlan(
  input: TranscriptAdapterInput,
  component: object,
  message: Record<string, unknown>,
  content: ReturnType<typeof normalizeMessageBlocks>,
): MessageViewKey | undefined {
  const known = input.state.identityOf(component) ?? input.state.identityOf(message);
  if (known) return known;
  // The host and extension receive the same object for EACH event. State
  // maps those per-delta copies to one logical plan, making the lookup above
  // the PRIMARY path. The heuristics below only serve components
  // whose message object was never anchored (history replay, cold start):
  // the state may already hold the OPEN plan for this message; reuse it
  // instead of sealing a second plan whose followsTools flag would be wrong.
  const contentBlocks = content;
  const hasText = contentBlocks.some((block) => block.type === "text" && block.text?.trim() !== "");
  const hasThinking = contentBlocks.some((block) => block.type === "thinking" && block.thinking?.trim() !== "");
  if (!hasText && !hasThinking) return undefined;
  const openKey = input.state.adoptOpenAssistantPlan(contentBlocks, component);
  if (openKey) return openKey;
  // Truly unknown message: register a sealed plan. The boundary decision
  // belongs to the STATE (display-order projection), not to the render path.
  const followsTools = input.state.lastNodeKind() === "exploration" || input.state.lastNodeKind() === "other-tool";
  return input.state.registerFinalizedMessage(
    { ...message, role: "assistant", content: contentBlocks },
    followsTools,
    component,
  );
}

/**
 * Map rebuilt children to semantic runs BY ORDER. The host emits visible
 * children in content order: text → Markdown, thinking → MouseRegion
 * (thinking), with structural Spacers between non-adjacent blocks. We skip
 * Spacers and empty runs (the host skips those too — its updateContent only
 * adds children for non-empty text/thinking).
 */
function mapChildrenToRuns(
  children: unknown[],
  runs: SemanticRun[],
  spacerProto: object | undefined,
): Array<{ child: object; run: SemanticRun }> {
  const isSpacer = (child: unknown): boolean =>
    !!child && typeof child === "object" && spacerProto !== undefined && Object.getPrototypeOf(child) === spacerProto;
  const pairs: Array<{ child: object; run: SemanticRun }> = [];
  let runIndex = 0;
  for (const child of children) {
    if (!child || typeof child !== "object" || isSpacer(child)) continue;
    while (runIndex < runs.length && !runs[runIndex]!.nonEmpty) runIndex += 1;
    const run = runs[runIndex];
    if (!run) break;
    pairs.push({ child, run });
    runIndex += 1;
  }
  return pairs;
}
