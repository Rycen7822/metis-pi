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
import { TranscriptState, renderedThinkingRuns, type MessageViewKey } from "./transcript-state.ts";

const TOOL_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.tool-row.v4");
const ASSISTANT_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.assistant-deco.v2");
const THOUGHT_LABEL = Symbol.for("Rycen7822.pi-codex-appearance.thought-label.v1");

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
  streaming: "full" | "collapsed";
  completed: "full" | "collapsed";
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
  externalRailOwner?(): boolean;
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
      coordinateSubtree(input, this as object, getSpacerProto());
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
    railReason: input.makeRail !== undefined
      ? (input.externalRailOwner?.() ? "external rail owner detected; our rail stays passive" : "thinking rail enabled")
      : "no rail factory provided",
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
  for (const run of renderedThinkingRuns(normalizeBlocks(content))) {
    const plan = key !== undefined ? input.state.thinkingRunPlan(key, run.runIndex) : undefined;
    const ended = plan ? plan.ended : run.endedInContent;
    // Streaming policy: fires when the run first renders WHILE ACTIVE — an
    // already-ended run (restored history) goes straight to the completion
    // policy instead.
    let streaming = streamingApplied.get(component);
    if (!streaming) streamingApplied.set(component, (streaming = new Set()));
    if (!streaming.has(run.runIndex)) {
      streaming.add(run.runIndex);
      if (!ended && apply(run.runIndex, policy.streaming === "collapsed")) changed = true;
    }
    // Completion policy: fires once on the active→ended transition. A forced
    // open (completed=full) only happens when an override entry already exists.
    if (ended) {
      let completion = completionApplied.get(component);
      if (!completion) completionApplied.set(component, (completion = new Set()));
      if (!completion.has(run.runIndex)) {
        completion.add(run.runIndex);
        const desired = policy.completed === "collapsed";
        if ((desired || map.has(run.runIndex)) && apply(run.runIndex, desired)) changed = true;
      }
    }
  }
  return changed;
}

function normalizeBlocks(content: Array<Record<string, unknown>>): Array<{ type: string; text?: string; thinking?: string }> {
  return content.map((block) => ({
    type: String(block.type ?? ""),
    text: typeof block.text === "string" ? block.text : undefined,
    thinking: typeof block.thinking === "string" ? block.thinking : undefined,
  }));
}

/** True when a non-thinking block exists after the run's first block — the
 * host's rebuild loop breaks there, so the run cannot grow anymore. */
function contentEndedAfter(content: Array<Record<string, unknown>>, firstContentIndex: number): boolean {
  return content.slice(firstContentIndex + 1).some((block) => String(block.type ?? "") !== "thinking");
}

/**
 * Re-coordinate the freshly rebuilt contentContainer: map semantic slots,
 * attach ONE separator before the first text run (when the plan says so),
 * wrap expanded thinking runs with our rail (unless an external owner did it)
 * and swap the host's collapsed labels for duration summaries.
 * Runs on every rebuild; each pass leaves exactly one matching decoration.
 */
function coordinateSubtree(input: TranscriptAdapterInput, component: object, spacerProto: object | undefined): void {
  const record = component as Record<string, unknown>;
  const message = asRecord(record.lastMessage);
  if (!message || message.role !== "assistant") return;
  const container = asRecord(record.contentContainer);
  const children = container.children;
  if (!Array.isArray(children)) return;

  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const planKey = resolveMessagePlan(input, component, message, content);
  const textRunPlan = planKey !== undefined ? input.state.textRunPlan(planKey) : undefined;
  const railBlocked = input.externalRailOwner?.() === true;

  // 1) Remove OUR stale decorations from the current subtree (they get
  //    re-added below at the right slots). Components removed by clear() lose
  //    container membership but stay usable — reuse keeps identity stable.
  //    Rails are UNWRAPPED, not deleted: a MouseRegion whose inner child we
  //    wrapped keeps its click semantics; restore the original child so the
  //    decoration never rides along after dispose.
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as Record<string, unknown> | null;
    if (!child || typeof child !== "object") continue;
    if ((child as Record<symbol, unknown>)[RAIL_SYMBOL]) {
      children.splice(i, 1);
      continue;
    }
    // Rails AND thought summaries ride inside the region's child slot; both
    // remember the original so the unwrap pass can restore it — a later pass
    // (or a successor install) must re-decide from the NATIVE node, never
    // inherit a stale summary.
    const innerWrapper = (child as Record<string, unknown>).child as (Record<symbol | string, unknown> & { original?: unknown }) | undefined;
    if (innerWrapper && typeof innerWrapper === "object" && (innerWrapper[RAIL_SYMBOL] || innerWrapper[THOUGHT_LABEL])) {
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
  // Host parity: the host's thinkingRunIndex counts only RENDERED (non-empty)
  // thinking runs, in content order.
  let thinkingOrdinal = 0;
  for (const run of runs) {
    if (run.kind === "thinking" && run.nonEmpty) run.thinkingRunIndex = thinkingOrdinal++;
  }
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
  if ((input.makeRail && !railBlocked) || (input.makeThoughtSummary && input.isCollapsedLabel)) {
    for (const slot of slots) {
      if (slot.run.kind !== "thinking" || !slot.run.nonEmpty) continue;
      const child = slot.child as Record<string, unknown>;
      // Host shape (pi-tui MouseRegion): `child` field holds the wrapped
      // component. Swap the region's inner child in place: the region keeps
      // its own click semantics and geometry.
      const inner = child && typeof child === "object" && "child" in child
        ? (child as { child: unknown }).child
        : child;
      const innerRecord = inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : undefined;
      if (!inner || ((inner as Record<symbol, unknown>))[RAIL_SYMBOL] || ((inner as Record<symbol, unknown>))[THOUGHT_LABEL]) continue;

      const isExpandedMarkdown = !!innerRecord && ("theme" in innerRecord || "defaultTextStyle" in innerRecord);
      if (isExpandedMarkdown) {
        if (!input.makeRail || railBlocked) continue;
        const wrapped = input.makeRail(inner);
        if (!wrapped) continue;
        ((wrapped as Record<symbol, unknown>))[RAIL_SYMBOL] = true;
        // Remember the original child so the unwrap pass (step 1) can restore it.
        (wrapped as Record<symbol | string, unknown>)["original"] = inner;
        if (inner !== child) {
          (child as { child: unknown }).child = wrapped;
        } else {
          const index = children.indexOf(child);
          if (index >= 0) children[index] = wrapped;
        }
        continue;
      }

      if (!input.makeThoughtSummary || !input.isCollapsedLabel?.(inner)) continue;
      const ordinal = slot.run.thinkingRunIndex;
      if (ordinal === undefined) continue;
      const plan = planKey !== undefined ? input.state.thinkingRunPlan(planKey, ordinal) : undefined;
      const ended = plan ? plan.ended : contentEndedAfter(content, slot.run.firstContentIndex);
      if (!ended) continue;
      const paddingX = typeof record.outputPad === "number" ? record.outputPad : 1;
      const summary = input.makeThoughtSummary({ durationMs: plan?.thinkingMs, runIndex: ordinal, ended: true, paddingX });
      if (!summary || typeof summary !== "object") continue;
      ((summary as Record<symbol, unknown>))[THOUGHT_LABEL] = true;
      // Remember the original child so the unwrap pass (step 1) can restore it.
      (summary as Record<symbol | string, unknown>)["original"] = inner;
      if (inner !== child) {
        (child as { child: unknown }).child = summary;
      } else {
        const index = children.indexOf(child);
        if (index >= 0) children[index] = summary;
      }
    }
  }
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
  const contentBlocks = normalizeBlocks(content);
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

interface SemanticRun {
  kind: "text" | "thinking";
  firstContentIndex: number;
  nonEmpty: boolean;
  /** A toolCall/unknown block — produces no child but BREAKS runs. */
  barrier?: boolean;
  /** Host thinkingRunIndex (ordinal of rendered thinking runs); thinking runs only. */
  thinkingRunIndex?: number;
}

/** Contiguous same-kind visible runs of the message content. */
function semanticRuns(content: Array<Record<string, unknown>>): SemanticRun[] {
  // Host parity: each NON-EMPTY text block is its own child; consecutive
  // thinking blocks merge into ONE run ONLY when truly adjacent. ANY other
  // block breaks the run — including an EMPTY text block: the host's rebuild
  // loop breaks on the first non-thinking block regardless of emptiness.
  const runs: SemanticRun[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : null;
    if (!kind) {
      // toolCall/unknown: no visible run of its own, but BREAKS any adjacent
      // thinking run (host rebuild has one MouseRegion per contiguous
      // thinking run between other blocks).
      runs.push({ kind: "text", firstContentIndex: i, nonEmpty: false, barrier: true });
      continue;
    }
    const nonEmpty = kind === "text"
      ? (typeof block.text === "string" ? !!block.text.trim() : false)
      : (typeof block.thinking === "string" ? !!block.thinking.trim() : false);
    if (kind === "text") {
      // Every text block (even empty) breaks a thinking run; only non-empty
      // ones create a run of their own.
      runs.push({ kind, firstContentIndex: i, nonEmpty });
      continue;
    }
    const last = runs.at(-1);
    if (last && last.kind === "thinking") {
      last.nonEmpty = last.nonEmpty || nonEmpty;
      continue;
    }
    runs.push({ kind, firstContentIndex: i, nonEmpty });
  }
  return runs;
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
