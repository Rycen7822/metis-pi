// 0.7.0 regression suite: serial exploration grouping (with group-total
// refresh), stable separator plans (survive rebuilds), the assistant
// coordination layer (separator + thinking rail), write live preview and
// DIM span semantics.
//
// The separator/rail tests go through the REAL coordination function
// (installTranscriptDecorations on a fake AssistantMessageComponent that
// mirrors the host rebuild semantics), not through hand-injected plans.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptState, assistantHasVisibleText, assistantHasVisibleThinking, renderedThinkingRuns } from "../src/transcript-state.ts";
import { installTranscriptDecorations } from "../src/transcript-adapter.ts";
import { thoughtSummaryText } from "../src/thinking-summary.ts";
import { makeRenderers } from "../src/renderers.ts";
import { resolveWriteStage, renderWritePreview } from "../src/write-preview.ts";
import { renderDiffLines } from "../src/diff.ts";
import { styleToolOutputLine, reapplyDimAfterResets } from "../src/output-style.ts";
import { theme, FakeText, bindings } from "./helpers.mjs";

const DIM = "\x1b[2m";
const INTENSITY_OFF = "\x1b[22m";
const IMAGE_NAMES = [
  "all_results.png.png", "shampoo_results.png.png", "EMA_KL_results.png.png",
  "ema_results.png.png", "frob_results.png.png", "larger.png.png",
  "trace_results.png.png", "trace_comparison_results.png.png",
];

function fakeStateSession() {
  return {
    colorLevel: { kind: "truecolor" },
    writeChanges: new Map(),
    transcript: new TranscriptState(),
  };
}

// ---------------------------------------------------------------------------
// Minimal host mirrors (real rebuild semantics, NOT hand-wired plans)
// ---------------------------------------------------------------------------

/** Mirrors pi-tui Spacer. */
class FakeSpacer {
  render() { return [""]; }
}

/** Mirrors pi-tui Markdown (text child). */
class FakeMarkdown {
  text: string;
  pad = 1;
  // Mirrors the real pi-tui Markdown instance shape (theme is ALWAYS set by
  // the host constructor); the adapter's rail targets expanded Markdown by
  // this structural marker, never by content.
  theme: Record<string, unknown> = {};
  constructor(text: string, pad = 1) {
    this.text = text;
    this.pad = pad;
  }
  render(width: number) { return [this.text]; }
}

/** Mirrors pi-tui MouseRegion (thinking wrapper: child + onMouse). */
class FakeMouseRegion {
  child: unknown;
  onMouse: (e: unknown) => unknown;
  constructor(child: unknown, onMouse: (e: unknown) => unknown) {
    this.child = child;
    this.onMouse = onMouse;
  }
  render(width: number) { return (this.child as FakeMarkdown).render(width); }
  handleMouse(event: unknown) { return this.onMouse(event); }
}

/** Mirrors pi AssistantMessageComponent with FULL rebuild semantics:
 * override map, hideThinkingBlock, host run grouping (consecutive thinking
 * blocks = one run; all-empty runs consume no runIndex), collapsed Text
 * labels and the native click toggle that rebuilds via updateContent. */
class FakeAssistantComponent {
  contentContainer = { children: [] as unknown[] };
  lastMessage: unknown;
  hideThinkingBlock = false;
  hiddenThinkingLabel = "Thinking...";
  thinkingVisibilityOverrides = new Map<number, boolean>();
  isStreaming = false;
  /** Number of ORIGINAL rebuilds (wrapper +1s observable here). */
  updateCalls = 0;
  constructor(message: unknown) {
    this.lastMessage = message;
    if (message) this.updateContent(message);
  }
  setHideThinkingBlock(hide: boolean) {
    this.hideThinkingBlock = hide;
    this.thinkingVisibilityOverrides.clear();
    if (this.lastMessage) this.updateContent(this.lastMessage);
  }
  updateContent(message: unknown, isStreaming = this.isStreaming) {
    this.updateCalls += 1;
    this.lastMessage = message;
    this.isStreaming = isStreaming;
    const content = Array.isArray((message as { content?: unknown[] })?.content) ? (message as { content: Array<Record<string, unknown>> }).content : [];
    const children: unknown[] = [];
    const hasVisible = content.some((b) => (b.type === "text" && typeof b.text === "string" && b.text.trim()) || (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()));
    if (hasVisible) children.push(new FakeSpacer());
    let thinkingRunIndex = 0;
    for (let i = 0; i < content.length; i++) {
      const block = content[i]!;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        children.push(new FakeMarkdown(block.text));
      } else if (block.type === "thinking") {
        const thinkingBlocks: string[] = [];
        for (; i < content.length; i++) {
          const t = content[i]!;
          if (t.type !== "thinking") break;
          if (typeof t.thinking === "string" && t.thinking.trim()) thinkingBlocks.push(t.thinking);
        }
        i--;
        if (thinkingBlocks.length === 0) continue;
        const runIndex = thinkingRunIndex++;
        const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
        const inner: unknown = hidden ? new FakeText(this.hiddenThinkingLabel) : new FakeMarkdown(thinkingBlocks.join("\n\n"));
        children.push(new FakeMouseRegion(inner, () => {
          this.thinkingVisibilityOverrides.set(runIndex, !hidden);
          if (this.lastMessage) this.updateContent(this.lastMessage);
          return { handled: true };
        }));
      }
    }
    this.contentContainer.children = children;
  }
}

/** Install decorations with a state + fake separator/rail factories. */
function setup(state: TranscriptState) {
  const separators: unknown[] = [];
  const rails: unknown[] = [];
  const handle = installTranscriptDecorations({
    state,
    toolPrototype: undefined,
    assistantPrototype: FakeAssistantComponent.prototype as unknown as object,
    makeSeparator: () => {
      const sep = new FakeMarkdown("─".repeat(80));
      separators.push(sep);
      return sep;
    },
    makeSpacer: () => new FakeSpacer(),
    makeRail: (child) => {
      const rail = createTestRail(child);
      rails.push(rail);
      return rail;
    },
    enabled: () => true,
  });
  return { handle, separators, rails };
}

let railSeq = 0;
function createTestRail(child: unknown) {
  const id = ++railSeq;
  return {
    railId: id,
    wrapped: child,
    render(width: number) { return (child as FakeMarkdown).render(width); },
  };
}

const countSeps = (component: FakeAssistantComponent) =>
  component.contentContainer.children.filter((c) => (c as FakeMarkdown).text === "─".repeat(80)).length;
const countRails = (component: FakeAssistantComponent) =>
  component.contentContainer.children.filter((c) => "railId" in (c as object)).length +
  component.contentContainer.children.filter((c) => c instanceof FakeMouseRegion && (c as FakeMouseRegion).child && "railId" in ((c as FakeMouseRegion).child as object)).length;

// ---------------------------------------------------------------------------
// A. separator persistence through rebuilds (3.1/3.2/5.3)
// ---------------------------------------------------------------------------

test("separator survives 100 streaming updates of the SAME logical message", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  const { handle } = setup(state);
  assert.equal(handle.features.find((f) => f.name === "separator")?.installed, true);
  // The host streams one AssistantMessage object; the decoration layer sees
  // message_update → object stays the same → identity stays the same.
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  const component = new FakeAssistantComponent(messageObj);
  // Coordinate on each update (the prototype wrapper does this automatically;
  // here we drive the fake manually through its own wrapper).
  for (let i = 1; i <= 100; i++) {
    messageObj.content = [{ type: "text", text: `delta stream ${i}` }];
    component.updateContent(messageObj);
    state.apply({ type: "message_update", message: JSON.parse(JSON.stringify({ role: "assistant", content: messageObj.content })) }, messageObj);
    assert.equal(countSeps(component), 1, `update ${i}: exactly one separator`);
  }
});

test("separator sits before the TEXT run when thinking precedes it", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  setup(state);
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  const component = new FakeAssistantComponent(messageObj);
  messageObj.content = [{ type: "thinking", thinking: "Let me check…" }, { type: "text", text: "Answer." }];
  component.updateContent(messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me check…" }, { type: "text", text: "Answer." }] } }, messageObj);
  const children = component.contentContainer.children;
  const sepIndex = children.findIndex((c) => (c as FakeMarkdown).text === "─".repeat(80));
  const thinkingIndex = children.findIndex((c) => c instanceof FakeMouseRegion);
  const textIndex = children.findIndex((c) => c instanceof FakeMarkdown && (c as FakeMarkdown).text === "Answer.");
  assert.ok(sepIndex > thinkingIndex, "separator after thinking");
  assert.equal(sepIndex, textIndex - 1, "separator immediately before text");
});

test("separator survives message_end, invalidate and re-render cycles", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false });
  setup(state);
  const messageObj = { role: "assistant", content: [{ type: "text", text: "done" }] };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj);
  state.apply({ type: "message_end", message: { role: "assistant", content: messageObj.content } }, messageObj);
  for (let i = 0; i < 5; i++) {
    component.updateContent(messageObj); // host invalidate() → updateContent
    assert.equal(countSeps(component), 1, `cycle ${i}`);
  }
});

test("assistant text with NO prior tools gets no separator", () => {
  const state = new TranscriptState();
  setup(state);
  const messageObj = { role: "assistant", content: [{ type: "text", text: "fresh answer" }] };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj);
  assert.equal(countSeps(component), 0);
});

test("user boundary between tools and text: no separator", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "q" }] } });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
  setup(state);
  const messageObj = { role: "assistant", content: [{ type: "text", text: "reply" }] };
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj);
  assert.equal(countSeps(component), 0);
});

test("two separate assistant messages after one tool: one separator EACH", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  setup(state);
  const objA = { role: "assistant", content: [{ type: "text", text: "first" }] };
  const compA = new FakeAssistantComponent(objA);
  state.apply({ type: "message_update", message: { role: "assistant", content: objA.content } }, objA);
  compA.updateContent(objA);
  assert.equal(countSeps(compA), 1);
  // Second message: lastNode is now assistant-text → NO separator.
  const objB = { role: "assistant", content: [{ type: "text", text: "second" }] };
  state.apply({ type: "message_start", message: { role: "assistant", content: objB.content } }, objB);
  state.apply({ type: "message_update", message: { role: "assistant", content: objB.content } }, objB);
  const compB = new FakeAssistantComponent(objB);
  compB.updateContent(objB);
  assert.equal(countSeps(compB), 0, "second message has no separator (no new tools)");
});

// ---------------------------------------------------------------------------
// B. thinking rail (semantic blocks only)
// ---------------------------------------------------------------------------

test("rail wraps thinking runs, never text runs", () => {
  const state = new TranscriptState();
  setup(state);
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "step one" },
    { type: "text", text: "plain English with the word Thinking inside" },
    { type: "thinking", thinking: "step two" },
  ] };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj);
  const children = component.contentContainer.children;
  const wrapped = children.filter((c) => c instanceof FakeMouseRegion && "railId" in ((c as FakeMouseRegion).child as object));
  assert.equal(wrapped.length, 2, "both thinking runs wrapped");
  const textChild = children.find((c) => c instanceof FakeMarkdown && (c as FakeMarkdown).text.includes("Thinking"));
  assert.ok(textChild, "text stays unwrapped");
});

test("0.8.1: expanded thinking Markdown keeps its body after thinking ends (never a label)", () => {
  const state = new TranscriptState();
  setup(state);
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "deep reasoning body" },
    { type: "text", text: "final answer" },
  ] } as { role: string; content: Array<{ type: string; thinking?: string; text?: string }> };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_end", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj); // coordinate pass (same as host rebuild)
  const unwrap = (c: unknown): unknown => {
    if (c instanceof FakeMouseRegion) {
      const inner = (c as FakeMouseRegion).child as { wrapped?: unknown } | undefined;
      return inner && typeof inner === "object" && "wrapped" in inner ? inner.wrapped : c;
    }
    return c;
  };
  const findBody = (): FakeMarkdown | undefined =>
    component.contentContainer.children
      .map(unwrap)
      .find((c) => c instanceof FakeMarkdown && (c as FakeMarkdown).text.includes("deep reasoning body")) as FakeMarkdown | undefined;
  assert.ok(findBody(), "thinking body Markdown present");
  // Rebuild path (host re-renders on click/refresh): body must survive verbatim.
  component.updateContent(messageObj);
  assert.ok(findBody(), "thinking body survives re-coordination");
  const texts = component.contentContainer.children.map((c) => {
    const inner = c instanceof FakeMouseRegion ? (c.child as FakeMarkdown) : (c as FakeMarkdown);
    return typeof inner?.text === "string" ? inner.text : "";
  }).join("\n");
  assert.ok(!texts.includes("Thought for"), "no auto label anywhere");
});

test("0.8.1: empty text block breaks thinking continuity (host parity)", () => {
  const state = new TranscriptState();
  setup(state);
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "a" },
    { type: "text", text: "" },
    { type: "thinking", thinking: "b" },
  ] } as { role: string; content: Array<{ type: string; thinking?: string; text?: string }> };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj); // coordinate pass
  // FakeAssistantComponent only creates MouseRegion children for non-empty
  // thinking blocks — empty text creates NO child and must break the run,
  // so both thinking blocks get their own rail (2 wrapped regions).
  const wrapped = component.contentContainer.children
    .filter((c) => c instanceof FakeMouseRegion && "wrapped" in ((c as FakeMouseRegion).child as object));
  assert.equal(wrapped.length, 2, "empty text breaks the thinking run like the host loop does");
});

test("0.8.1: toolCall block breaks thinking continuity (barrier run)", () => {
  const state = new TranscriptState();
  setup(state);
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "before tool" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "after tool" },
  ] } as { role: string; content: Array<{ type: string; thinking?: string; id?: string; name?: string }> };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(messageObj);
  component.updateContent(messageObj);
  // Host rebuild: each thinking run = own MouseRegion; toolCall has NO child
  // in the assistant component. Both thinking runs must be wrapped.
  const wrapped = component.contentContainer.children
    .filter((c) => c instanceof FakeMouseRegion && "wrapped" in ((c as FakeMouseRegion).child as object));
  assert.equal(wrapped.length, 2, "toolCall breaks the thinking run (two rails, never one merged)");
});

test("plain English text never gets a rail (semantic typing only)", () => {
  assert.equal(assistantHasVisibleThinking({ role: "assistant", content: [{ type: "text", text: "Writing the body draft now." }] }), false);
  assert.equal(assistantHasVisibleThinking({ role: "assistant", content: [{ type: "text", text: "Thinking about it." }] }), false);
});

// ---------------------------------------------------------------------------
// C. exploration grouping + group-total refresh (D: duplicate image totals)
// ---------------------------------------------------------------------------

test("8 serial reads: one group, ordered members, totals refresh on append", () => {
  const state = new TranscriptState();
  IMAGE_NAMES.forEach((_, i) => {
    state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}` }] } });
    state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}` }] } });
    state.apply({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", isError: false, imageCount: 1 });
  });
  const ids = state.groupMemberIds(1);
  assert.equal(ids.length, 8);
  // Group total from the CURRENT plan is stable regardless of member age:
  const headPlan = state.explorationPlan("t0");
  assert.equal(headPlan?.groupImages, 8);
  // Dirty views include every member after appends (renderer refresh hints).
  const dirty = state.takeDirtyViews();
  assert.ok(dirty.some((k) => k.startsWith("member:")), "member refresh hints present");
});

test("renderers: only the CURRENT last member carries the aggregated notice", () => {
  const session = fakeStateSession();
  const renderers = makeRenderers((s) => new FakeText(s), () => "ctrl+o to expand", undefined, undefined, undefined, undefined, session);
  const state = session.transcript;
  // 8 serial reads like the screenshot.
  IMAGE_NAMES.forEach((_, i) => {
    state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: `img${i}` }] } });
    state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `img${i}` }] } });
    state.apply({ type: "tool_execution_start", toolCallId: `img${i}`, toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: `img${i}`, toolName: "read", isError: false, imageCount: 1 });
  });
  // Render EVERY member's call row (both slots, no injected plans).
  for (let i = 0; i < 8; i++) {
    const ctx = { toolCallId: `img${i}`, isPartial: false, state: {}, args: { path: `figures/${IMAGE_NAMES[i]}` } };
    const call = renderers.read.renderCall({ path: `figures/${IMAGE_NAMES[i]}` }, theme, ctx);
    const text = call.render(100).join("\n");
    const plan = state.explorationPlan(`img${i}`);
    const showsTotal = plan?.isLastMember === true ? /8 images/.test(text) : !/images/.test(text);
    assert.ok(showsTotal, `member ${i}: total only on the current last member`);
    assert.doesNotMatch(text, /1 image\b/, `member ${i}: no per-member 1 image`);
  }
});

test("group stays open across tool-call-only assistant messages", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.equal(state.explorationPlan("b")?.groupId, state.explorationPlan("a")?.groupId);
});

test("boundaries: bash/foreign/failed/visible-thinking split the group", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "sh", toolName: "bash" });
  assert.equal(state.explorationPlan("sh"), undefined);
  assert.notEqual(state.explorationPlan("t2")?.groupId, state.explorationPlan("a")?.groupId);
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true });
  assert.equal(state.groupOpen("a"), false);
});

test("parallel reads keep creation order; duplicate events are idempotent", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "A", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "B", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "A", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "B", toolName: "read", isError: false });
  state.apply({ type: "tool_execution_end", toolCallId: "B", toolName: "read", isError: false });
  state.apply({ type: "tool_execution_end", toolCallId: "A", toolName: "read", isError: false, imageCount: 1 });
  assert.deepEqual(state.groupMemberIds(1), ["A", "B"]);
  assert.equal(state.explorationPlan("A")?.groupImages, 1);
});

// ---------------------------------------------------------------------------
// D. write live preview (stage model + bounded rolling tail)
// ---------------------------------------------------------------------------

test("write stage resolution across the host lifecycle", () => {
  assert.equal(resolveWriteStage({ argsComplete: false }), "receiving-arguments");
  assert.equal(resolveWriteStage({ argsComplete: true }), "arguments-ready");
  assert.equal(resolveWriteStage({ argsComplete: true, executionStarted: true }), "executing");
  assert.equal(resolveWriteStage({ hasResult: true, isError: false }), "succeeded");
  assert.equal(resolveWriteStage({ hasResult: true, isError: true }), "failed-or-aborted");
  assert.equal(resolveWriteStage({ hasResult: true, aborted: true }), "failed-or-aborted");
});

test("renderWritePreview: bounded rows, dim stage label, no success green", () => {
  const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = renderWritePreview(content, {
    width: 80, stage: "receiving-arguments", expanded: false,
    theme, colorLevel: { kind: "truecolor" },
    layout: { wrap: (t, w) => [t], visibleWidth: (t) => t.length },
    gutter: "  │ ",
  });
  assert.ok(out.length <= 12, `max 12 rows, got ${out.length}`);
  assert.match(out[0]!, /Receiving content · preview, not yet committed/);
  assert.match(out[0]!, /\x1b\[2m/, "stage label dimmed");
  assert.doesNotMatch(out.join("\n"), /Added|Edited|Written/);
  // Expanded shows everything.
  const expandedOut = renderWritePreview(content, {
    width: 80, stage: "receiving-arguments", expanded: true,
    theme, colorLevel: { kind: "truecolor" },
    layout: { wrap: (t, w) => [t], visibleWidth: (t) => t.length },
    gutter: "  │ ",
  });
  assert.match(expandedOut.join("\n"), /line 30/);
});

// ---------------------------------------------------------------------------
// E. DIM semantics (span decoding)
// ---------------------------------------------------------------------------

function decodeSpans(line: string) {
  const spans: Array<{ text: string; dim: boolean; fg: unknown }> = [];
  let dim = false;
  let fg: unknown = null;
  let buffer = "";
  const flush = () => { if (buffer) { spans.push({ text: buffer, dim, fg }); buffer = ""; } };
  const re = /\x1b\[([0-9;:]*)([a-zA-Z])/g;
  let cursor = 0;
  let match;
  while ((match = re.exec(line))) {
    buffer += line.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[2] !== "m") continue;
    flush();
    const params = match[1].split(";").filter(Boolean).map(Number);
    const effective: unknown[] = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === 38 || p === 48 || p === 58) {
        const mode = params[i + 1];
        const skip = mode === 2 ? 5 : mode === 5 ? 3 : 1;
        effective.push(params.slice(i, i + skip).join(";"));
        i += skip - 1;
      } else effective.push(p);
    }
    for (const p of effective) {
      if (typeof p === "string") { fg = p; continue; }
      if (p === 0) { dim = false; fg = null; }
      else if (p === 22) dim = false;
      else if (p === 2) dim = true;
      else if (p === 39) fg = null;
      else if ((p >= 30 && p <= 38) || (p >= 90 && p <= 97)) fg = p;
    }
  }
  buffer += line.slice(cursor);
  flush();
  return spans;
}

test("DIM: source colors survive, resets re-acquire DIM, RGB untouched", () => {
  const red = decodeSpans(styleToolOutputLine("\x1b[31mred\x1b[0mplain-after-reset", { dim: true, colorLevel: { kind: "truecolor" } }));
  const redSpan = red.find((s) => s.text.includes("red"))!;
  assert.equal(redSpan.dim, true);
  assert.equal(redSpan.fg, 31);
  const after = red.find((s) => s.text.includes("plain-after"))!;
  assert.equal(after.dim, true);

  const rgb = decodeSpans(styleToolOutputLine("\x1b[38;2;0;22;39mRGB\x1b[39mdefault", { dim: true, colorLevel: { kind: "truecolor" } }));
  const rgbSpan = rgb.find((s) => s.text.includes("RGB"))!;
  assert.equal(rgbSpan.dim, true);
  assert.equal(rgbSpan.fg, "38;2;0;22;39");

  const idx = decodeSpans(styleToolOutputLine("\x1b[38;5;22mindexed\x1b[0mplain", { dim: true, colorLevel: { kind: "ansi256" } }));
  assert.equal(idx.find((s) => s.text.includes("indexed"))!.fg, "38;5;22");

  // Idempotence: restyling does not stack.
  const once = styleToolOutputLine("text", { dim: true, colorLevel: { kind: "truecolor" } });
  const twice = styleToolOutputLine(once, { dim: true, colorLevel: { kind: "truecolor" } });
  assert.ok(decodeSpans(twice).every((s) => s.dim));

  // no-color: no SGR at all.
  assert.equal(styleToolOutputLine("\x1b[31mred\x1b[0m", { dim: true, colorLevel: { kind: "none" } }), "\x1b[31mred\x1b[0m");
});


test("per-run plans: clock starts once at first text, closes on the text boundary", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
  messageObj.content = [{ type: "thinking", thinking: "hmm" }];
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  let plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.ok(plan, "run plan exists while streaming");
  assert.equal(plan!.ended, false);
  assert.equal(plan!.startedAt, 1_000);
  clock += 7_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.equal(plan!.startedAt, 1_000, "cumulative updates never reset the start clock");
  messageObj.content = [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Answer." }];
  clock += 2_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.equal(plan!.ended, true, "a non-thinking block after the run closes its clock");
  assert.equal(plan!.endedAt, 10_000);
  assert.equal(plan!.thinkingMs, 9_000);
  // textRunPlan is separator-only now (single timing source lives per run).
  const textPlan = state.textRunPlan(state.messageKeyFor(messageObj));
  assert.equal(textPlan?.thinkingMs, undefined);
  assert.equal("thinkingEnded" in (textPlan ?? {}), false);
});

test("per-run plans: toolCall splits runs with independent clocks; message_end closes the tail", () => {
  let clock = 0;
  const state = new TranscriptState(() => clock);
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
  messageObj.content = [{ type: "thinking", thinking: "run zero" }];
  clock = 1_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  messageObj.content = [
    { type: "thinking", thinking: "run zero" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "run one" },
  ];
  clock = 6_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const key = state.messageKeyFor(messageObj);
  const runs = state.thinkingRunPlans(key);
  assert.equal(runs.length, 2, "toolCall splits the runs");
  assert.equal(runs[0]!.ended, true, "run 0 closed by the toolCall boundary");
  assert.equal(runs[0]!.endedAt, 6_000);
  assert.equal(runs[0]!.thinkingMs, 5_000);
  assert.equal(runs[1]!.ended, false, "run 1 still streaming");
  clock = 9_500;
  state.apply({ type: "message_end", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const sealed = state.thinkingRunPlans(state.identityOf(messageObj)!);
  assert.equal(sealed[1]!.ended, true, "message_end closes the trailing run");
  assert.equal(sealed[1]!.endedAt, 9_500);
  assert.equal(sealed[1]!.thinkingMs, 3_500);
  assert.equal(sealed[0]!.endedAt, 6_000, "closed runs never extend at message_end");
});

test("per-run plans: all-empty runs consume no host runIndex; no timing without evidence", () => {
  const state = new TranscriptState();
  const message = { role: "assistant" as const, content: [
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "real thought" },
  ] };
  const key = state.registerFinalizedMessage(message, false);
  const runs = state.thinkingRunPlans(key);
  assert.equal(runs.length, 1, "empty block merges into one rendered run");
  assert.equal(runs[0]!.runIndex, 0);
  assert.equal(runs[0]!.ended, true, "finalized history runs count as ended");
  assert.equal(runs[0]!.thinkingMs, undefined, "no fabricated duration for history");
});

test("0.8.1 doc diff surface: full-row bg on add/remove incl. blank add, context plain", () => {
  const rows = [
    { kind: "context", oldNumber: 1, newNumber: 1, content: "original line" },
    { kind: "add", newNumber: 2, content: "## Added heading" },
    { kind: "add", newNumber: 3, content: "" },
    { kind: "remove", oldNumber: 2, content: "old removed" },
  ];
  const out = renderDiffLines({
    rows,
    width: 60,
    layout: { wrap: (t: string) => [t], visibleWidth: (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "").length },
    colorLevel: { kind: "truecolor" },
    expanded: false,
    expandHint: "",
  });
  const joined = out.join("\n");
  assert.match(out[0]!, /^  1  original line$/, "context row: no bg, gutter+space+content");
  assert.match(joined, /\x1b\[48;2;33;58;43m/, "add rows carry #213A2B line bg");
  assert.match(joined, /\x1b\[48;2;74;34;29m/, "remove rows carry #4A221D line bg");
  assert.match(out[2]!, /\x1b\[48;2;33;58;43m {2}3 \x1b\[32m\x1b\[48;2;33;58;43m\+\x1b\[39m +\x1b\[49m$/, "BLANK added row still has full-row bg incl. right padding");
  assert.ok(!out[0]!.includes("48;2;"), "context row has no background");
  // bg reset must close each styled row (surface never leaks past the row).
  for (const line of out.slice(1)) assert.match(line, /\x1b\[49m$/, "bg reset closes the row");
});

// ---------------------------------------------------------------------------
// E. thinking visibility policy (0.9.2): auto-collapse via the HOST's
// thinkingVisibilityOverrides, applied once per transition; native click
// toggle and Ctrl+T stay in charge; duration labels only on ended runs.
// ---------------------------------------------------------------------------

interface Policy {
  streaming: "full" | "collapsed";
  completed: "full" | "collapsed";
}

let activePolicyHandle: { dispose(): void } | undefined;

function setupWithPolicy(state: TranscriptState, policy: Policy) {
  // One live install at a time: tests run sequentially on the SHARED fake
  // prototype, and a leaked policy wrapper would keep writing overrides.
  activePolicyHandle?.dispose();
  const summaries: FakeText[] = [];
  const rails: unknown[] = [];
  const separators: unknown[] = [];
  const handle = installTranscriptDecorations({
    state,
    toolPrototype: undefined,
    assistantPrototype: FakeAssistantComponent.prototype as unknown as object,
    makeSeparator: () => {
      const sep = new FakeMarkdown("─".repeat(80));
      separators.push(sep);
      return sep;
    },
    makeSpacer: () => new FakeSpacer(),
    makeRail: (child) => {
      const rail = createTestRail(child);
      rails.push(rail);
      return rail;
    },
    thinkingPolicy: () => policy,
    makeThoughtSummary: (input) => {
      const label = new FakeText(thoughtSummaryText(input.durationMs));
      summaries.push(label);
      return label;
    },
    isCollapsedLabel: (node) => node instanceof FakeText,
    enabled: () => true,
  });
  activePolicyHandle = handle;
  return { handle, summaries, rails, separators };
}

const regionsOf = (component: FakeAssistantComponent): FakeMouseRegion[] =>
  component.contentContainer.children.filter((c): c is FakeMouseRegion => c instanceof FakeMouseRegion);

/** Inner display node of a region, unwrapping a rail wrapper when present. */
function innerOf(region: FakeMouseRegion): unknown {
  const child = region.child as { wrapped?: unknown } | undefined;
  return child && typeof child === "object" && "wrapped" in child ? child.wrapped : region.child;
}

const summaryLabels = (component: FakeAssistantComponent, summaries: FakeText[]): FakeText[] =>
  regionsOf(component)
    .map((region) => region.child)
    .filter((child): child is FakeText => summaries.includes(child as FakeText));

const click = (region: FakeMouseRegion): void => {
  region.handleMouse({ type: "click", button: "left" });
};

test("policy: streaming stays expanded, auto-collapse fires ONCE with the run duration", () => {
  let clock = 5_000;
  const state = new TranscriptState(() => clock);
  const { handle, summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  messageObj.content = [{ type: "thinking", thinking: "deep thought" }];
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  assert.ok(innerOf(regionsOf(component)[0]!) instanceof FakeMarkdown, "expanded while streaming");
  assert.equal(component.thinkingVisibilityOverrides.size, 0, "full policy needs no override for new runs");

  messageObj.content = [{ type: "thinking", thinking: "deep thought" }, { type: "text", text: "Answer." }];
  clock = 12_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const before = component.updateCalls;
  component.updateContent(messageObj, true);
  assert.equal(component.updateCalls - before, 2, "exactly ONE extra host rebuild on the transition");
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1, "collapsed run shows the duration summary");
  assert.equal(labels[0]!.text, "Thought for 7s");

  const steady = component.updateCalls;
  component.updateContent(messageObj, true);
  assert.equal(component.updateCalls - steady, 1, "steady updates never re-apply the policy");
  assert.equal(handle.thinkingAutoApplied(), 1, "one applied visibility transition total");

  // Native toggle: click the summary → the full body returns (with rail).
  click(regionsOf(component)[0]!);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "host map owns the manual state");
  assert.ok((innerOf(regionsOf(component)[0]!) as FakeMarkdown).text.includes("deep thought"), "body restored verbatim");
  // Click the expanded body → collapsed again; the policy stays out of the way.
  click(regionsOf(component)[0]!);
  assert.equal(summaryLabels(component, summaries).length, 1, "summary restored after second click");
  assert.equal(handle.thinkingAutoApplied(), 1);
});

test("policy: manual collapse during streaming is kept; completion only adds the duration", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "work in progress" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);
  // User collapses the ACTIVE run manually.
  click(regionsOf(component)[0]!);
  assert.ok(regionsOf(component)[0]!.child instanceof FakeText, "hidden while active");
  assert.equal(summaryLabels(component, summaries).length, 0, "ACTIVE hidden run keeps the host's own label");

  messageObj.content = [{ type: "thinking", thinking: "work in progress" }, { type: "text", text: "done" }];
  clock = 4_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const before = component.updateCalls;
  component.updateContent(messageObj, true);
  assert.equal(component.updateCalls - before, 1, "already-hidden run: completion adds no rebuild");
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1, "ended run shows the duration");
  assert.equal(labels[0]!.text, "Thought for 3s");
});

test("policy: Ctrl+T show is not undone; hide keeps working; full/full never collapses", () => {
  let clock = 0;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "reasoned" }, { type: "text", text: "reply" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_end", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj);
  assert.equal(summaryLabels(component, summaries).length, 1, "auto-collapsed at rest");

  // Ctrl+T show: host clears the map; the applied-once state must not re-collapse.
  component.setHideThinkingBlock(false);
  assert.equal(component.thinkingVisibilityOverrides.size, 0, "host cleared the map");
  assert.ok(innerOf(regionsOf(component)[0]!) instanceof FakeMarkdown, "expanded after global show");
  component.updateContent(messageObj);
  component.updateContent(messageObj);
  assert.ok(innerOf(regionsOf(component)[0]!) instanceof FakeMarkdown, "redraws keep it expanded");
  // Manual collapse then global show again: still expanded.
  click(regionsOf(component)[0]!);
  component.setHideThinkingBlock(false);
  assert.ok(innerOf(regionsOf(component)[0]!) instanceof FakeMarkdown);
  // Global hide: host label comes back (ended run gets the duration swap).
  component.setHideThinkingBlock(true);
  assert.equal(summaryLabels(component, summaries).length, 1, "ended run keeps the duration label under global hide");

  // completed=full must never force a collapse of runs hidden only by hideAll.
  const fullState = new TranscriptState(() => clock);
  const full = setupWithPolicy(fullState, { streaming: "full", completed: "full" });
  fullState.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  fullState.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const fullComponent = new FakeAssistantComponent(undefined);
  fullComponent.hideThinkingBlock = true;
  fullComponent.updateContent(messageObj);
  assert.equal(fullComponent.thinkingVisibilityOverrides.size, 0, "no override written against global hide");
  assert.equal(summaryLabels(fullComponent, full.summaries).length, 1, "ended run keeps the duration label under global hide");
});

test("policy: two runs collapse independently with their own durations", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "run zero" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);
  messageObj.content = [
    { type: "thinking", thinking: "run zero" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "run one" },
  ];
  clock = 6_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  assert.equal(regionsOf(component).length, 2, "toolCall keeps two regions");
  assert.equal((regionsOf(component)[0]!.child as FakeText).text, "Thought for 5s", "run 0 duration from its own clock");
  assert.ok(innerOf(regionsOf(component)[1]!) instanceof FakeMarkdown, "run 1 still expanded");

  messageObj.content = [
    { type: "thinking", thinking: "run zero" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "run one" },
    { type: "text", text: "final" },
  ];
  clock = 9_500;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  assert.equal((regionsOf(component)[1]!.child as FakeText).text, "Thought for 3s", "run 1 collapses on the text boundary");
  // Clicking run 0 does not disturb run 1.
  click(regionsOf(component)[0]!);
  assert.ok((innerOf(regionsOf(component)[0]!) as FakeMarkdown).text.includes("run zero"), "run 0 expanded");
  assert.ok(regionsOf(component)[1]!.child instanceof FakeText, "run 1 stays collapsed");
});

test("policy: streaming=collapsed hides active runs once; duration appears at completion", () => {
  let clock = 2_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "collapsed", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "quiet work" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true, "streaming policy applied once");
  assert.ok(regionsOf(component)[0]!.child instanceof FakeText, "hidden while streaming");
  assert.equal(summaryLabels(component, summaries).length, 0, "host label kept while active");

  messageObj.content = [{ type: "thinking", thinking: "quiet work" }, { type: "text", text: "out" }];
  clock = 4_500;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1);
  assert.equal(labels[0]!.text, "Thought for 2s");
});

test("policy: history rebuild collapses without timing evidence ('Thought', never 0s)", () => {
  const state = new TranscriptState();
  const { summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL old reasoning" },
    { type: "text", text: "old answer" },
  ] } as { role: string; content: Array<Record<string, unknown>> };
  // No transcript events: the component resolves a finalized plan itself.
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj);
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1, "history run auto-collapsed once");
  assert.equal(labels[0]!.text, "Thought", "honest fallback without timing");
  click(regionsOf(component)[0]!);
  assert.ok((innerOf(regionsOf(component)[0]!) as FakeMarkdown).text.includes("EXPANDED_THINKING_SENTINEL"), "click restores the full original body");
});

test("policy: aborted message still collapses its run; plain text is never a summary", () => {
  let clock = 3_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "full", completed: "collapsed" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "interrupted thought" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);
  messageObj.stopReason = "aborted";
  state.apply({ type: "message_end", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, false);
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1, "run that existed keeps its duration across abort");
  assert.equal(labels[0]!.text, "Thought for 0s", "same-tick close is honest 0s, not fabricated");

  const plain = { role: "assistant", content: [{ type: "text", text: "Thinking about it. Writing the body draft now." }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: plain.content } }, plain);
  state.apply({ type: "message_update", message: { role: "assistant", content: plain.content } }, plain);
  const plainComponent = new FakeAssistantComponent(undefined);
  plainComponent.updateContent(plain);
  assert.equal(summaryLabels(plainComponent, summaries).length, 0, "text-only message never produces a summary");
  assert.equal(regionsOf(plainComponent).length, 0, "no thinking regions for plain text");
});

test("renderedThinkingRuns: host parity for empty runs, barriers and boundaries", () => {
  assert.deepEqual(renderedThinkingRuns([{ type: "thinking", thinking: "a" }]), [
    { runIndex: 0, firstContentIndex: 0, endedInContent: false },
  ]);
  assert.deepEqual(renderedThinkingRuns([{ type: "thinking", thinking: "" }]), [], "all-empty run consumes no runIndex");
  assert.deepEqual(renderedThinkingRuns([
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "b" },
  ]), [{ runIndex: 0, firstContentIndex: 0, endedInContent: false }], "empty block merges forward");
  assert.deepEqual(renderedThinkingRuns([
    { type: "thinking", thinking: "a" },
    { type: "toolCall", id: "t" },
    { type: "thinking", thinking: "b" },
  ]), [
    { runIndex: 0, firstContentIndex: 0, endedInContent: true },
    { runIndex: 1, firstContentIndex: 2, endedInContent: false },
  ], "non-thinking blocks split runs and end the earlier one");
  assert.deepEqual(renderedThinkingRuns([
    { type: "thinking", thinking: "a" },
    { type: "text", text: "" },
    { type: "thinking", thinking: "b" },
  ])[1]!.runIndex, 1, "an EMPTY text block still breaks the run (host loop)");
});

test("policy: collapsed/full opens the run once at completion via its own override", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setupWithPolicy(state, { streaming: "collapsed", completed: "full" });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "quiet then loud" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true, "hidden while streaming");
  messageObj.content = [{ type: "thinking", thinking: "quiet then loud" }, { type: "text", text: "out" }];
  clock = 3_500;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "completion policy opens the run it hid");
  assert.ok(innerOf(regionsOf(component)[0]!) instanceof FakeMarkdown, "expanded after completion (full policy)");
  assert.equal(summaryLabels(component, summaries).length, 0, "no duration label on an expanded run");
});

// --- 0.12.0: the peek window -------------------------------------------------

interface TestPeek {
  readonly kind: "peek";
  readonly wrapped: unknown;
  readonly control: ThinkingViewControl;
  readonly windowLines: number;
  readonly onScroll: () => void;
}
interface TestClickable {
  readonly kind: "clickable";
  readonly wrapped: unknown;
  readonly control: ThinkingViewControl;
  readonly fallback: ThinkingView;
  readonly apply: (next: ThinkingView) => void;
}

/** Installs the display policy WITH the peek/click wrappers, recording them. */
function setupWithPeek(state: TranscriptState, policy: { streaming: "peek" | "full" | "collapsed"; completed: "collapsed" | "full"; peekLines: number }) {
  activePolicyHandle?.dispose();
  const rails: unknown[] = [];
  const peeks: TestPeek[] = [];
  const clickables: TestClickable[] = [];
  const summaries: FakeText[] = [];
  const handle = installTranscriptDecorations({
    state,
    toolPrototype: undefined,
    assistantPrototype: FakeAssistantComponent.prototype as unknown as object,
    makeSeparator: () => new FakeMarkdown("─".repeat(80)),
    makeSpacer: () => new FakeSpacer(),
    makeRail: (child) => {
      const rail = createTestRail(child);
      rails.push(rail);
      return rail;
    },
    makePeek: (input) => {
      const peek: TestPeek = {
        kind: "peek",
        wrapped: input.inner,
        control: input.control,
        windowLines: input.windowLines,
        onScroll: input.onScroll,
      };
      peeks.push(peek);
      return peek;
    },
    makeClickable: (input) => {
      const clickable: TestClickable = {
        kind: "clickable",
        wrapped: input.inner,
        control: input.control,
        fallback: input.fallback,
        apply: input.apply,
      };
      clickables.push(clickable);
      return clickable;
    },
    thinkingPolicy: () => policy,
    makeThoughtSummary: (input) => {
      const label = new FakeText(thoughtSummaryText(input.durationMs));
      summaries.push(label);
      return label;
    },
    isCollapsedLabel: (node) => node instanceof FakeText,
    enabled: () => true,
  });
  activePolicyHandle = handle;
  return { handle, peeks, clickables, rails, summaries };
}

/** Walk every wrapper layer (click layer, rail, peek window) to the host body. */
function unwrapAll(node: unknown): unknown {
  let current = node;
  for (let i = 0; i < 5; i += 1) {
    const wrapped = (current as { wrapped?: unknown } | undefined)?.wrapped;
    if (wrapped === undefined) break;
    current = wrapped;
  }
  return current;
}

/** Unwrap the click layer (always outermost in 0.12.0) and return it. */
function clickableOf(component: FakeAssistantComponent, index = 0): TestClickable {
  const child = regionsOf(component)[index]!.child as TestClickable;
  assert.equal(child.kind, "clickable", "the click layer wraps the whole block");
  return child;
}

test("peek: an active run renders as a wheel window sized by the policy, with a click layer outside", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { peeks, clickables } = setupWithPeek(state, { streaming: "peek", completed: "collapsed", peekLines: 5 });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "long reasoning body" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);

  const clickable = clickableOf(component);
  const rail = clickable.wrapped as { wrapped?: unknown };
  const peek = rail.wrapped as TestPeek;
  assert.equal(peek.kind, "peek", "rail wraps the peek window");
  assert.equal(peek.windowLines, 5, "window height comes from the policy");
  assert.ok(peek.wrapped instanceof FakeMarkdown, "the peek slices the host's own body");
  assert.equal(clickables.length, 1, "one click layer per run");
  assert.equal(peeks.length, 1, "one peek window per run");
  // A wheel that moved asks for the host rebuild (the only path that repaints).
  const before = component.updateCalls;
  peek.onScroll();
  assert.equal(component.updateCalls - before, 1, "scrolling repaints through updateContent");
});

test("peek: the completion fold happens once, so a later choice survives rebuilds", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { clickables } = setupWithPeek(state, { streaming: "peek", completed: "collapsed", peekLines: 6 });
  const messageObj = { role: "assistant", content: [{ type: "thinking", thinking: "run body" }] } as { role: string; content: Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: messageObj.content } }, messageObj);
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new FakeAssistantComponent(undefined);
  component.updateContent(messageObj, true);

  // The user double clicks the streaming window: peek → full.
  const streaming = clickableOf(component);
  streaming.control.handleClick({ at: 1_000, x: 4, y: 4 }, { fallback: streaming.fallback, apply: streaming.apply });
  streaming.control.handleClick({ at: 1_080, x: 4, y: 4 }, { fallback: streaming.fallback, apply: streaming.apply });
  assert.equal(streaming.control.userView(), "full", "double click opened the full body");
  assert.notEqual(component.thinkingVisibilityOverrides.get(0), true, "a shown run needs no override entry");
  component.updateContent(messageObj, true);
  assert.ok(unwrapAll(regionsOf(component)[0]!.child) instanceof FakeMarkdown, "full body, no window");

  // The run ends: the completion policy folds it once (the user's shape is dropped).
  messageObj.content = [{ type: "thinking", thinking: "run body" }, { type: "text", text: "out" }];
  clock = 4_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  component.updateContent(messageObj, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true, "auto-folded at completion");
  const collapsedChild = clickableOf(component).wrapped;
  assert.ok(collapsedChild instanceof FakeText, "collapsed label shown");

  // The user opens it again AFTER the run ended: no later rebuild may re-fold it.
  const ended = clickableOf(component);
  ended.control.handleClick({ at: 5_000, x: 4, y: 4 }, { fallback: ended.fallback, apply: ended.apply });
  ended.control.handleClick({ at: 5_080, x: 4, y: 4 }, { fallback: ended.fallback, apply: ended.apply });
  assert.equal(ended.control.userView(), "full", "post-completion choice recorded");
  for (let i = 0; i < 3; i += 1) component.updateContent(messageObj, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "rebuilds keep the run open");
  assert.ok(unwrapAll(regionsOf(component)[0]!.child) instanceof FakeMarkdown, "and keep the full body");
});
