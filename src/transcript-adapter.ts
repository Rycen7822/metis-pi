// transcript-adapter.ts — connects the presentation state to the live Pi UI.
//
// One assistant decoration layer coordinates BOTH the separator line and the
// thinking rail against the rebuilt contentContainer (they must not stack two
// unaware patches on the same updateContent). Tool-row decoration suppresses
// the leading spacer of grouped exploration members.
//
// Coordination contract (5.3): call the approved predecessor ONCE, read the
// REBUILT subtree, map text/thinking slots semantically, then re-attach the
// decorations the current subtree needs. "Idempotent" means exactly one
// matching decoration in the CURRENT subtree — not "insert once per parent
// lifetime". Removed-by-clear() decorations are re-attached.
//
// External owner awareness: pi-zentui's thinkingSteps (mode rail/tree) may
// already own assistant thinking display. When its wrapper is detected, the
// rail is skipped (external rail wins) while the separator stays active.

import { asRecord } from "./renderers.ts";
import { TranscriptState, type ExplorationPlan, type TextRunPlan } from "./transcript-state.ts";

const TOOL_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.tool-row.v4");
const ASSISTANT_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.assistant-deco.v2");

/** Per-feature install diagnostics (3.3: never aggregate with .some()). */
export interface DecorationFeature {
  readonly name: "separator" | "thinking-rail" | "group-spacing";
  readonly installed: boolean;
  readonly reason: string;
}

export interface DecorationHandle {
  readonly installed: boolean;
  readonly features: readonly DecorationFeature[];
  dispose(): void;
}

function methodBody(fn: Function): string {
  const text = Function.prototype.toString.call(fn);
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}")).replace(/\s+/g, "");
}

function failed(features: DecorationFeature[]): DecorationHandle {
  return { installed: false, features, dispose() {} };
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
  /** Format the collapsed-run label with the measured duration ("Thought for 19s
   * (ctrl+t to expand)"). Absent → keep the host's own label. */
  thoughtLabel?: (thinkingMs: number) => string | undefined;
  /** True when an external owner already renders thinking rails. */
  externalRailOwner?(): boolean;
  enabled(): boolean;
}

/** Structural prefix of the stock updateDisplay (bg function head only —
 * resilient to trailing code changes, strict about its identity). */
const UPDATE_DISPLAY_HEAD = "letbgFn=this.isPartial?";
const UPDATE_DISPLAY_HEAD_ALT = "constbgFn=this.isPartial?(";
/** Structural prefix of the stock updateContent. */
const UPDATE_CONTENT_HEAD = "this.lastMessage=message;this.isStreaming=isStreaming;this.contentContainer.clear();";

const RAIL_SYMBOL = Symbol.for("Rycen7822.pi-codex-appearance.thinking-rail");
const SEP_SYMBOL = Symbol.for("Rycen7822.pi-codex-appearance.separator");

export function installTranscriptDecorations(input: TranscriptAdapterInput): DecorationHandle {
  const features: DecorationFeature[] = [];
  const disposers: Array<() => void> = [];
  if (input.toolPrototype) {
    const result = decorateToolRows(input);
    features.push({ name: "group-spacing", installed: result.installed, reason: result.reason });
    if (result.installed) disposers.push(result.dispose);
  }
  if (input.assistantPrototype) {
    const result = decorateAssistant(input);
    features.push(
      { name: "separator", installed: result.installed, reason: result.reason },
      { name: "thinking-rail", installed: result.railInstalled, reason: result.railReason },
    );
    if (result.installed || result.railInstalled) disposers.push(result.dispose);
  }
  const installed = features.some((f) => f.installed);
  return { installed, features, dispose() { for (const d of disposers) d(); } };
}

// ---------------------------------------------------------------------------
// Tool rows: suppress the leading spacer of non-first exploration members.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Assistant subtree: separator before the first text run + rail on thinking
// runs, re-coordinated after EVERY rebuild.
// ---------------------------------------------------------------------------

function decorateAssistant(input: TranscriptAdapterInput): {
  installed: boolean; reason: string;
  railInstalled: boolean; railReason: string;
  dispose: () => void;
} {
  const prototype = input.assistantPrototype!;
  const key = "updateContent";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return { installed: false, reason: "Pi updateContent missing or read-only", railInstalled: false, railReason: "no updateContent access", dispose() {} };
  }
  // Structural contract (3.3): the method exists, is writable/configurable,
  // and the rebuilt subtree exposes the host's contentContainer. String
  // fingerprints are deliberately NOT used — comments, minification or
  // benign patches (e.g. zentui's wrapper) must not block installation.
  const original = descriptor.value as (this: unknown, ...args: unknown[]) => void;
  const owner = {};

  // zentui's thinking wrapper chains on the same method. If an outer wrapper
  // was installed AFTER ours, our dispose keeps the outer wrapper but makes
  // this layer transparent (still calling through). If zentui installed
  // BEFORE us, the descriptor we captured is already ITS wrapper and our
  // decoration sits on top — chain order works either way; ownership is per
  // descriptor, and later installers fail closed on the shape check only when
  // the body actually diverges.
  let active = true;

  const wrapper = function (this: unknown, ...args: unknown[]): void {
    original.apply(this, args);
    if (!active || !input.enabled() || typeof this !== "object" || this === null) return;
    try {
      coordinateSubtree(input, this as object);
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
 * Re-coordinate the freshly rebuilt contentContainer: map semantic slots,
 * attach ONE separator before the first text run (when the plan says so) and
 * wrap thinking runs with our rail (unless an external owner did it).
 * Runs on every rebuild; each pass leaves exactly one matching decoration.
 */
function coordinateSubtree(input: TranscriptAdapterInput, component: object): void {
  const record = component as Record<string, unknown>;
  const message = asRecord(record.lastMessage);
  if (!message || message.role !== "assistant") return;
  const container = asRecord(record.contentContainer);
  const children = container.children;
  if (!Array.isArray(children)) return;

  const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  const textRunPlan = resolveTextRunPlan(input, component, message, content);
  const railBlocked = input.externalRailOwner?.() === true;
  const spacerProto = input.makeSpacer ? Object.getPrototypeOf(input.makeSpacer()) : undefined;

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
    // MouseRegion with our wrapper inside: unwrap in place.
    if ((child as Record<string, unknown>).child && ((child as Record<string, unknown>).child as Record<symbol, unknown> | undefined)?.[RAIL_SYMBOL]) {
      const region = child as { child: Record<symbol, unknown> };
      const wrapper = region.child;
      const original = (wrapper as Record<symbol | string, unknown>)?.["original"];
      if (original !== undefined) {
        region.child = original as Record<symbol, unknown>;
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
  // slots: array of { child, run } pairs (skipping structural Spacers).

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

  // 4) Thinking runs: rail + "Thought for Xs" label. The host renders a
  //    HIDDEN (collapsed) run as a plain Text with `hiddenThinkingLabel` and
  //    an OPEN run as Markdown inside a MouseRegion. Distinguish by node
  //    shape (Text vs Markdown), never by content strings.
  if (input.makeRail && !railBlocked) {
    for (const slot of slots) {
      if (slot.run.kind !== "thinking") continue;
      const child = slot.child as Record<string, unknown>;
      // Host shape (pi-tui MouseRegion): `child` field holds the wrapped
      // component. Swap the region's inner child in place: the region keeps
      // its own click semantics and geometry; the rail decorates the render.
      const inner = child && typeof child === "object" && "child" in child
        ? (child as { child: unknown }).child
        : child;
      if (!inner || ((inner as Record<symbol, unknown>))[RAIL_SYMBOL]) continue;

      // Collapsed runs (host Text) get their label enriched with the measured
      // duration — display copy only; the host's own override map stays sole
      // owner of VISIBILITY (user clicks beat our automatic collapse).
      const innerText = (inner as { text?: unknown }).text;
      const isCollapsedLabel = typeof innerText === "string" && !(inner as { markdown?: unknown }).markdown;
      if (isCollapsedLabel && textRunPlan?.thinkingEnded && typeof input.thoughtLabel === "function") {
        const label = input.thoughtLabel(textRunPlan.thinkingMs ?? 0);
        if (label && typeof (inner as { setText?: unknown }).setText === "function") {
          try {
            (inner as { setText: (next: string) => void }).setText(label);
          } catch {
            // display-only enrichment; keep the host label on failure
          }
        }
        continue; // no rail on the collapsed label row
      }

      const wrapped = input.makeRail(inner);
      if (!wrapped) continue;
      ((wrapped as Record<symbol, unknown>))[RAIL_SYMBOL] = true;
      // Remember the original child so the unwrap pass (step 1) can restore
      // the host's own node verbatim on dispose/rebuild.
      (wrapped as Record<symbol | string, unknown>)["original"] = inner;
      if (inner !== child) {
        (child as { child: unknown }).child = wrapped;
      } else {
        const index = children.indexOf(child);
        if (index >= 0) children[index] = wrapped;
      }
    }
  }
}

/** Resolve the stable TextRunPlan for the component's current message. */
function resolveTextRunPlan(
  input: TranscriptAdapterInput,
  component: object,
  message: Record<string, unknown>,
  content: Array<Record<string, unknown>>,
): TextRunPlan | undefined {
  const known = input.state.identityOf(component);
  if (known) return input.state.textRunPlan(known);
  // History/finalized components without a streaming anchor: the state may
  // already hold the OPEN plan for this message (message_update ran without
  // a component reference). Reuse it instead of sealing a second plan whose
  // followsTools flag would be wrong (lastNode is already assistant-text).
  const contentBlocks = content.map((b) => ({ type: String(b.type ?? ""), text: typeof b.text === "string" ? b.text : undefined, thinking: typeof b.thinking === "string" ? b.thinking : undefined }));
  const hasText = content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
  if (!hasText) return undefined;
  const openKey = input.state.adoptOpenAssistantPlan(contentBlocks, component);
  if (openKey) return input.state.textRunPlan(openKey);
  // Truly unknown message (history replay, cold start): register a sealed
  // plan. The boundary decision belongs to the STATE (display-order
  // projection), not to the render path — followsTools comes from the
  // state's own lastNode.
  const followsTools = input.state.lastNodeKind() === "exploration" || input.state.lastNodeKind() === "other-tool";
  const key = input.state.registerFinalizedMessage(
    { role: "assistant", content: contentBlocks, stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined },
    followsTools,
    component,
  );
  return input.state.textRunPlan(key);
}

interface SemanticRun {
  kind: "text" | "thinking";
  firstContentIndex: number;
  nonEmpty: boolean;
}

/** Contiguous same-kind visible runs of the message content. */
function semanticRuns(content: Array<Record<string, unknown>>): SemanticRun[] {
  // 0.8.0 semantics (mirrors the host rebuild): each NON-EMPTY text block is
  // its own child; consecutive thinking blocks merge into ONE run ONLY when
  // nothing breaks between them (a toolCall or a text block breaks the run —
  // the host loop breaks on the first non-thinking block too). Blocks of the
  // same kind separated by other kinds are separate runs.
  const runs: SemanticRun[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i]!;
    const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : null;
    if (!kind) continue; // toolCall/unknown breaks any run
    const nonEmpty = kind === "text"
      ? (typeof block.text === "string" ? !!block.text.trim() : false)
      : (typeof block.thinking === "string" ? !!block.thinking.trim() : false);
    if (kind === "text") {
      // One run per non-empty text block — the host emits one Markdown child each.
      if (nonEmpty) runs.push({ kind, firstContentIndex: i, nonEmpty: true });
      continue;
    }
    // thinking: merge only consecutive thinking blocks (the host merges them
    // into a single Markdown inside one MouseRegion).
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
    // Advance to the next non-empty run for this visible child.
    while (runIndex < runs.length && !runs[runIndex]!.nonEmpty) runIndex += 1;
    const run = runs[runIndex];
    if (!run) break;
    pairs.push({ child, run });
    runIndex += 1;
  }
  return pairs;
}
