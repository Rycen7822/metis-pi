// transcript-adapter.ts — connects the presentation state to the live Pi UI.
//
// Two scoped, ownership-checked prototype decorations (the same pattern as
// adapter.ts: exact method-body signatures, owner slot, full restore):
//   1. ToolExecutionComponent.prototype.updateDisplay — exploration members
//      read their ExplorationPlan and drop the leading Spacer for non-first
//      members (the group header of the first member provides the spacing).
//   2. AssistantMessageComponent.prototype.updateContent — injects one
//      SeparatorComponent at the TOP of contentContainer when the state says
//      this assistant text segment follows tool activity. updateContent()
//      rebuilds children on every call, so the injection is re-applied there
//      and stays idempotent (keyed by segment, checked per rebuild).
//
// No Container/TUI prototypes, no global stdout, no Markdown rewrites.

import { asRecord } from "./renderers.ts";
import { TranscriptState, type ExplorationPlan } from "./transcript-state.ts";

const TOOL_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.tool-row.v3");
const ASSISTANT_SLOT = Symbol.for("Rycen7822.pi-codex-appearance.assistant-sep.v1");

export interface DecorationHandle {
  readonly installed: boolean;
  readonly reason: string;
  dispose(): void;
}

function methodBody(fn: Function): string {
  const text = Function.prototype.toString.call(fn);
  return text.slice(text.indexOf("{") + 1, text.lastIndexOf("}")).replace(/\s+/g, "");
}

function skipped(reason: string): DecorationHandle {
  return { installed: false, reason, dispose() {} };
}

export interface TranscriptAdapterInput {
  state: TranscriptState;
  /** Prototype of Pi's ToolExecutionComponent (classic interactive mode). */
  toolPrototype: object | undefined;
  /** Prototype of Pi's AssistantMessageComponent. */
  assistantPrototype: object | undefined;
  /** Build the separator line component (width-aware at render time). */
  makeSeparator: () => unknown;
  /** Build a 1-row spacer (restore path for de-grouped rows). */
  makeSpacer: () => unknown;
  enabled(): boolean;
}

const EXPECTED_UPDATE_DISPLAY =
  "constbgFn=this.isPartial?(text)=>theme.bg(\"toolPendingBg\",text):this.result?.isError?(text)=>theme.bg(\"toolErrorBg\",text):(text)=>theme.bg(\"toolSuccessBg\",text);";
const EXPECTED_UPDATE_CONTENT = "this.lastMessage=message;this.isStreaming=isStreaming;this.contentContainer.clear();";

export function installTranscriptDecorations(input: TranscriptAdapterInput): DecorationHandle {
  const handles: DecorationHandle[] = [];
  if (input.toolPrototype) handles.push(decorateToolRows(input));
  if (input.assistantPrototype) handles.push(decorateAssistantSeparator(input));
  const installed = handles.some((h) => h.installed);
  return {
    installed,
    reason: installed ? "transcript decorations enabled" : handles[0]?.reason ?? "no host prototypes provided",
    dispose() {
      for (const handle of handles) handle.dispose();
    },
  };
}

/** Decoration 1: member rows of an exploration group suppress their leading
 * spacer. The first member keeps it (visually the group header block). */
function decorateToolRows(input: TranscriptAdapterInput): DecorationHandle {
  const prototype = input.toolPrototype!;
  if (Object.prototype.hasOwnProperty.call(prototype, TOOL_SLOT)) return skipped("Another copy is already installed");
  const key = "updateDisplay";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return skipped("Unrecognized or read-only Pi UI method: updateDisplay");
  }
  const body = methodBody(descriptor.value);
  if (!body.startsWith(EXPECTED_UPDATE_DISPLAY)) {
    return skipped("Unrecognized or already modified Pi tool-row updateDisplay");
  }
  const original = descriptor.value as (this: unknown) => void;
  const owner = {};
  const decoratedRows = new WeakSet<object>();

  function planFor(row: object): ExplorationPlan | undefined {
    const id = asRecord(row).toolCallId;
    if (typeof id !== "string") return undefined;
    return input.state.explorationPlan(id);
  }

  const wrapper = function (this: unknown): void {
    const previousSpacerState = decoratedRows.has(this as object);
    let suppress = false;
    if (input.enabled() && typeof this === "object" && this !== null) {
      const plan = planFor(this as object);
      suppress = plan?.suppressLeadingSpacer === true;
    }
    const row = this as object;
    const record = asRecord(row);
    if (suppress && !previousSpacerState) {
      // Drop the leading Spacer child (children[0] when stock). render() and
      // Container.handleMouse derive their geometry from the same children
      // list, so hit-testing stays aligned without manual offsets.
      const children = record.children;
      if (Array.isArray(children) && children.length > 1 && (children[0] as { constructor?: { name?: string } })?.constructor?.name === "Spacer") {
        children.shift();
        decoratedRows.add(row);
      }
    } else if (!suppress && previousSpacerState) {
      // Plan changed back (ungrouped): restore a spacer if we removed one.
      const children = record.children;
      if (Array.isArray(children)) {
        const spacer = input.makeSpacer();
        if (spacer) children.unshift(spacer);
      }
      decoratedRows.delete(row);
    }
    return original.call(this);
  };

  try {
    Object.defineProperty(prototype, TOOL_SLOT, { value: owner, configurable: true });
    Object.defineProperty(prototype, key, { ...descriptor, value: wrapper });
  } catch {
    return skipped("Pi tool-row prototype cannot be decorated");
  }
  return {
    installed: true,
    reason: "exploration member spacing enabled",
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

/** Decoration 2: separator before assistant text that follows tool activity.
 * The host rebuilds contentContainer in updateContent, so we re-inject after
 * the original rebuild each time — keyed by the state's segment, idempotent. */
function decorateAssistantSeparator(input: TranscriptAdapterInput): DecorationHandle {
  const prototype = input.assistantPrototype!;
  if (Object.prototype.hasOwnProperty.call(prototype, ASSISTANT_SLOT)) return skipped("Another copy is already installed");
  const key = "updateContent";
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return skipped("Unrecognized or read-only Pi UI method: updateContent");
  }
  const body = methodBody(descriptor.value);
  if (!body.startsWith(EXPECTED_UPDATE_CONTENT)) {
    return skipped("Unrecognized or already modified Pi assistant updateContent");
  }
  const original = descriptor.value as (this: unknown, ...args: unknown[]) => void;
  const owner = {};
  const separatorOf = new WeakMap<object, unknown>();

  const wrapper = function (this: unknown, ...args: unknown[]): void {
    original.apply(this, args);
    if (!input.enabled() || typeof this !== "object" || this === null) return;
    const component = this as object;
    const message = asRecord((component as Record<string, unknown>).lastMessage);
    if (!message || message.role !== "assistant") return;
    // Only real visible text segments carry the boundary (never thinking-only,
    // never tool-call-only): check the LAST update's message content.
    const content = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const hasText = content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
    if (!hasText) return;
    const container = asRecord((component as Record<string, unknown>).contentContainer);
    const children = container.children;
    if (!Array.isArray(children)) return;
    const plan = input.state.takeTextPlan();
    if (!plan.separatorBefore) return;
    // Idempotent within this component: one separator per assistant row.
    if (separatorOf.has(component)) return;
    const separator = input.makeSeparator();
    if (!separator) return;
    separatorOf.set(component, separator);
    // Place after the host's leading Spacer (children[0]) when present, else
    // at the very top: the line visually belongs to the text, not the tools.
    const firstIsSpacer = (children[0] as { constructor?: { name?: string } })?.constructor?.name === "Spacer";
    children.splice(firstIsSpacer ? 1 : 0, 0, separator);
  };
  try {
    Object.defineProperty(prototype, ASSISTANT_SLOT, { value: owner, configurable: true });
    Object.defineProperty(prototype, key, { ...descriptor, value: wrapper });
  } catch {
    return skipped("Pi assistant prototype cannot be decorated");
  }
  return {
    installed: true,
    reason: "assistant separator enabled",
    dispose() {
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
