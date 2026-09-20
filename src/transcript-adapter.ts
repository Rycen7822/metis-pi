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
import { TranscriptState, normalizeMessageBlocks, renderedThinkingRuns, semanticRuns, type SemanticRun, type MessageViewKey } from "./transcript-state.ts";
import { createThinkingViewControl, type ThinkingView, type ThinkingViewControl } from "./thinking-view.ts";

const TOOL_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.tool-row.v4");
const ASSISTANT_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.assistant-deco.v2");
const THOUGHT_LABEL = Symbol.for("Rycen7822.pi-codex-appearance.thought-label.v1");
const CLICK_SYMBOL = Symbol.for("Rycen7822.pi-codex-appearance.thinking-click.v1");

/** Per-feature install diagnostics (never aggregate with .some()). */
export interface DecorationFeature {
  readonly name: "separator" | "thinking-rail" | "group-spacing" | "thinking-policy";
  readonly installed: boolean;
  readonly reason: string;
}

export interface DecorationHandle {
  readonly installed: boolean;
  readonly features: readonly DecorationFeature[];
  /** Visibility transitions the policy has applied so far (diagnostics). */
  readonly thinkingAutoApplied: () => number;
  dispose(): void;
}

export interface ThinkingPolicy {
  streaming: "peek" | "full" | "collapsed";
  completed: "full" | "collapsed";
  /** Rows visible in the peek window (config already clamped it). */
  peekLines: number;
}

function methodBody(fn: Function): string {
  const text = Function.prototype.toString.call(fn);
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}")).replace(/\s+/g, "");
}

export interface TranscriptAdapterInput {
  state: TranscriptState;
  toolPrototype: object | undefined;
  assistantPrototype: object | undefined;
  /** Build the separator line component (width-aware at render time). */
  makeSeparator: () => unknown;
  /** Build a 1-row spacer (restore path for de-grouped rows). */
  makeSpacer: () => unknown;
  /**
   * Wrap a thinking display node with our rail. Returns undefined when the
   * host shape is not supported (the caller then leaves the node untouched).
   */
  makeRail: ((child: unknown) => unknown) | undefined;
  /** True when an external owner already renders thinking rails. */
  /**
   * Wrap a thinking body so left clicks drive the run's view state: a single
   * click folds/peeks, a double click toggles peek ↔ full (the control owns the
   * gesture and its pending click). Applied OUTSIDE the rail.
   */
  makeClickable?: (input: {
    inner: unknown;
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
  makeThoughtSummary?: (input: { durationMs?: number; runIndex: number; ended: boolean; paddingX: number }) => unknown;
  /**
   * Structural guard: is this node the host's collapsed-label Text? Must be a
   * real class/shape check from the host (e.g. `instanceof Tui.Text`) — never
   * a `.text` field sniff.
   */
  isCollapsedLabel?: (node: unknown) => boolean;
  enabled(): boolean;
}

/** Structural prefix of the stock updateDisplay (bg function head only —
 * resilient to trailing code changes, strict about its identity). */
const UPDATE_DISPLAY_HEAD = "letbgFn=this.isPartial?";
const UPDATE_DISPLAY_HEAD_ALT = "constbgFn=this.isPartial?(";
const RAIL_SYMBOL = Symbol.for("Rycen7822.pi-codex-appearance.thinking-rail");
const SEP_SYMBOL = Symbol.for("Rycen7822.pi-codex-appearance.separator");

export function installTranscriptDecorations(input: TranscriptAdapterInput): DecorationHandle {
  const features: DecorationFeature[] = [];
  const disposers: Array<() => void> = [];
  const autoApplied = { count: 0 };
  if (input.toolPrototype) {
    const result = decorateToolRows(input);
    features.push({ name: "group-spacing", installed: result.installed, reason: result.reason });
    if (result.installed) disposers.push(result.dispose);
  }
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
  const installed = features.some((f) => f.installed);
  return { installed, features, thinkingAutoApplied: () => autoApplied.count, dispose() { for (const d of disposers) d(); } };
}

/** Suppress the leading spacer of non-first exploration group members. */
function decorateToolRows(input: TranscriptAdapterInput): { installed: boolean; reason: string; dispose: () => void } {
  const prototype = input.toolPrototype!;
  if (Object.prototype.hasOwnProperty.call(prototype, TOOL_SLOT)) {
    return { installed: false, reason: "another copy owns tool-row decoration", dispose() {} };
  }
  const key = "updateDisplay";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return { installed: false, reason: "Pi tool-row updateDisplay missing or read-only", dispose() {} };
  }
  const body = methodBody(descriptor.value);
  // Pi's TS loader strips type annotations AND the const declaration can be
  // emitted as let; accept both stock shapes.
  if (!body.startsWith(UPDATE_DISPLAY_HEAD) && !body.startsWith(UPDATE_DISPLAY_HEAD_ALT)) {
    return { installed: false, reason: "unrecognized Pi tool-row updateDisplay shape (host changed or patched)", dispose() {} };
  }
  const original = descriptor.value as (this: unknown) => void;
  const owner = {};
  const spacerRemoved = new WeakSet<object>();

  const wrapper = function (this: unknown): void {
    const row = this as object;
    let suppress = false;
    if (input.enabled() && typeof this === "object" && this !== null) {
      const id = asRecord(row).toolCallId;
      const plan = typeof id === "string" ? input.state.explorationPlan(id) : undefined;
      suppress = plan?.suppressLeadingSpacer === true;
    }
    const record = asRecord(row);
    const children = record.children;
    const wasRemoved = spacerRemoved.has(row);
    if (suppress && !wasRemoved && Array.isArray(children) && children.length > 1
        && (children[0] as { constructor?: { name?: string } })?.constructor?.name === "Spacer") {
      children.shift();
      spacerRemoved.add(row);
    } else if (!suppress && wasRemoved && Array.isArray(children)) {
      const spacer = input.makeSpacer();
      if (spacer) children.unshift(spacer);
      spacerRemoved.delete(row);
    }
    return original.call(this);
  };

  try {
    Object.defineProperty(prototype, TOOL_SLOT, { value: owner, configurable: true });
    Object.defineProperty(prototype, key, { ...descriptor, value: wrapper });
  } catch {
    return { installed: false, reason: "Pi tool-row prototype cannot be decorated", dispose() {} };
  }
  return {
    installed: true,
    reason: "group spacing enabled",
    dispose() {
      try {
        if (Object.getOwnPropertyDescriptor(prototype, key)?.value === wrapper) {
          Object.defineProperty(prototype, key, descriptor);
        }
        if (Object.getOwnPropertyDescriptor(prototype, TOOL_SLOT)?.value === owner) {
          Reflect.deleteProperty(prototype, TOOL_SLOT);
        }
      } catch { /* frozen prototype keeps an inert wrapper */ }
    },
  };
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
    return { installed: false, reason: "Pi updateContent missing or read-only", railInstalled: false, railReason: "no updateContent access", dispose: () => {} };
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
  const streamingApplied = new WeakMap<object, Set<number>>();
  const completionApplied = new WeakMap<object, Set<number>>();

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

  const wrapper = function (this: unknown, ...args: unknown[]): void {
    original.apply(this, args);
    if (!active || !input.enabled() || typeof this !== "object" || this === null) return;
    try {
      // A visibility transition needs the host to REBUILD so the run renders
      // under its new hidden state. Call the CAPTURED original (never
      // this.updateContent — no wrapper recursion), at most ONE extra rebuild,
      // only when the override map actually changed.
      if (input.thinkingPolicy && applyThinkingPolicy(input, this as object, streamingApplied, completionApplied, autoApplied)) {
        original.apply(this, args);
      }
    } catch {
      // A policy failure must not break the original message display.
    }
    try {
      coordinateSubtree(input, this as object, getSpacerProto(), rebuild);
    } catch {
      // A presentation failure must not break the original message display.
    }
  };

  try {
    Object.defineProperty(prototype, ASSISTANT_SLOT, { value: owner, configurable: true });
    Object.defineProperty(prototype, key, { ...descriptor, value: wrapper });
  } catch {
    return { installed: false, reason: "Pi assistant prototype cannot be decorated", railInstalled: false, railReason: "cannot decorate", dispose() {} };
  }
  return {
    installed: true,
    reason: "assistant decoration layer enabled",
    railInstalled: input.makeRail !== undefined,
    railReason: input.makeRail !== undefined ? "thinking rail enabled" : "no rail factory provided",
    dispose() {
      active = false;
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
  component: object,
  streamingApplied: WeakMap<object, Set<number>>,
  completionApplied: WeakMap<object, Set<number>>,
  autoApplied: { count: number },
): boolean {
  const record = asRecord(component);
  const message = asRecord(record.lastMessage);
  if (!message || message.role !== "assistant") return false;
  const overrides = record.thinkingVisibilityOverrides;
  if (!overrides || typeof (overrides as Map<number, boolean>).get !== "function" || typeof (overrides as Map<number, boolean>).set !== "function") {
    return false; // host shape changed — native visibility stays in charge
  }
  const map = overrides as Map<number, boolean>;
  const policy = input.thinkingPolicy!();
  const hideAll = record.hideThinkingBlock === true;
  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const key = resolveMessagePlan(input, component, message, content);
  const apply = (runIndex: number, desired: boolean): boolean => {
    if ((map.get(runIndex) ?? hideAll) !== desired) {
      map.set(runIndex, desired);
      autoApplied.count += 1;
      return true;
    }
    return false;
  };
  let changed = false;
  for (const run of renderedThinkingRuns(normalizeMessageBlocks(content))) {
    const plan = key !== undefined ? input.state.thinkingRunPlan(key, run.runIndex) : undefined;
    const ended = plan ? plan.ended : run.endedInContent;
    // Per-run display state (click choice + peek scroll), stored with the run
    // clock so every later rebuild reuses the same one.
    const control = key !== undefined
      ? input.state.thinkingViewControl(key, run.runIndex, createThinkingViewControl)
      : createThinkingViewControl();
    // Streaming policy: fires when the run first renders WHILE ACTIVE — an
    // already-ended run (restored history) goes straight to the completion
    // policy instead.
    let streaming = streamingApplied.get(component);
    if (!streaming) streamingApplied.set(component, (streaming = new Set()));
    if (!streaming.has(run.runIndex)) {
      streaming.add(run.runIndex);
      if (!ended && apply(run.runIndex, policy.streaming === "collapsed")) changed = true;
    }
    // Completion policy: fires once on the active→ended transition and owns the
    // auto-fold — it forgets a shape the user opened while the run was still
    // streaming ("clicked it open, it folds when the thought ends") and hides
    // the run. A forced open (completed=full) only happens when an override
    // entry already exists; a run hidden only by the host's global
    // hideThinkingBlock is left alone.
    if (ended) {
      let completion = completionApplied.get(component);
      if (!completion) completionApplied.set(component, (completion = new Set()));
      if (!completion.has(run.runIndex)) {
        completion.add(run.runIndex);
        const desired = policy.completed === "collapsed";
        const forceOpen = !desired && map.has(run.runIndex);
        control.foldOnEnd();
        if ((desired || forceOpen) && apply(run.runIndex, desired)) changed = true;
      }
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
function coordinateSubtree(input: TranscriptAdapterInput, component: object, spacerProto: object | undefined, rebuild: (target: object) => void): void {
  const record = component as Record<string, unknown>;
  const message = asRecord(record.lastMessage);
  if (!message || message.role !== "assistant") return;
  const container = asRecord(record.contentContainer);
  const children = container.children;
  if (!Array.isArray(children)) return;

  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const planKey = resolveMessagePlan(input, component, message, content);
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
    if ((child as Record<symbol, unknown>)[RAIL_SYMBOL] || (child as Record<symbol, unknown>)[CLICK_SYMBOL]) {
      children.splice(i, 1);
      continue;
    }
    // Rails AND thought summaries ride inside the region's child slot; both
    // remember the original so the unwrap pass can restore it — a later pass
    // (or a successor install) must re-decide from the NATIVE node, never
    // inherit a stale summary.
    const innerWrapper = (child as Record<string, unknown>).child as (Record<symbol | string, unknown> & { original?: unknown }) | undefined;
    if (innerWrapper && typeof innerWrapper === "object" && (innerWrapper[RAIL_SYMBOL] || innerWrapper[THOUGHT_LABEL] || innerWrapper[CLICK_SYMBOL])) {
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
  const runs = semanticRuns(content);
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
  if (input.makeRail || (input.makeThoughtSummary && input.isCollapsedLabel) || (viewFeature && input.makeClickable)) {
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
        || ((inner as Record<symbol, unknown>))[CLICK_SYMBOL]) continue;

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
      let decorated = false;
      if (isExpandedMarkdown) {
        if (view === "peek" && control && input.makePeek && policy) {
          const peeked = input.makePeek({
            inner: node,
            control,
            windowLines: policy.peekLines,
            onScroll: () => rebuild(component),
          });
          if (peeked && typeof peeked === "object") node = peeked;
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
        if (!input.makeThoughtSummary || !input.isCollapsedLabel?.(inner) || !ended) continue;
        const paddingX = typeof record.outputPad === "number" ? record.outputPad : 1;
        const summary = input.makeThoughtSummary({ durationMs: plan?.thinkingMs, runIndex: ordinal ?? 0, ended: true, paddingX });
        if (!summary || typeof summary !== "object") continue;
        ((summary as Record<symbol, unknown>))[THOUGHT_LABEL] = true;
        node = summary;
        decorated = true;
      }

      // The click layer sits OUTSIDE the rail/peek/label: a click anywhere on
      // the block (rail column included) is ours, and the gesture state lives in
      // the run control — never in the instances this rebuild just replaced.
      if (control && input.makeClickable) {
        const clickable = input.makeClickable({
          inner: node,
          control,
          fallback: view,
          apply: (next) => applyThinkingView(component, ordinal ?? 0, next, rebuild),
        });
        if (clickable && typeof clickable === "object") {
          ((clickable as Record<symbol, unknown>))[CLICK_SYMBOL] = true;
          node = clickable;
          decorated = true;
        }
      }
      if (!decorated) continue;
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

/** Resolve the stable message key for the component's current message. */
function resolveMessagePlan(
  input: TranscriptAdapterInput,
  component: object,
  message: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
): MessageViewKey | undefined {
  const known = input.state.identityOf(component) ?? input.state.identityOf(message);
  if (known) return known;
  // The host passes the SAME message object it handed to the extension
  // events, and the state anchors it at message_start — so the object lookup
  // above is the PRIMARY path. The heuristics below only serve components
  // whose message object was never anchored (history replay, cold start):
  // the state may already hold the OPEN plan for this message; reuse it
  // instead of sealing a second plan whose followsTools flag would be wrong.
  const contentBlocks = normalizeMessageBlocks(content);
  const hasText = contentBlocks.some((block) => block.type === "text" && block.text?.trim() !== "");
  const hasThinking = contentBlocks.some((block) => block.type === "thinking" && block.thinking?.trim() !== "");
  if (!hasText && !hasThinking) return undefined;
  const openKey = input.state.adoptOpenAssistantPlan(contentBlocks, component);
  if (openKey) return openKey;
  // Truly unknown message: register a sealed plan. The boundary decision
  // belongs to the STATE (display-order projection), not to the render path.
  const followsTools = input.state.lastNodeKind() === "exploration" || input.state.lastNodeKind() === "other-tool";
  return input.state.registerFinalizedMessage(
    { role: "assistant", content: contentBlocks, stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined },
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
