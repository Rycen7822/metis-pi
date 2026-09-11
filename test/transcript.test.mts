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
import { TranscriptState, assistantHasVisibleText, assistantHasVisibleThinking } from "../src/transcript-state.ts";
import { installTranscriptDecorations } from "../src/transcript-adapter.ts";
import { makeRenderers } from "../src/renderers.ts";
import { resolveWriteStage, previewLines, renderWritePreview } from "../src/write-preview.ts";
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
    tracker: { trackStart() {}, trackEnd() {} },
    colorLevel: { kind: "truecolor" },
    writeChanges: new Map(),
    transcript: new TranscriptState(),
    resultImages: new Map(),
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

/** Mirrors pi AssistantMessageComponent: updateContent CLEARS the container
 * and rebuilds children from message.content every call. */
class FakeAssistantComponent {
  contentContainer = { children: [] as unknown[] };
  lastMessage: unknown;
  constructor(message: unknown) {
    this.lastMessage = message;
    this.updateContent(message);
  }
  updateContent(message: unknown, isStreaming = false) {
    this.lastMessage = message;
    const content = (Array.isArray((message as { content?: unknown[] })?.content) ? (message as { content: Array<Record<string, unknown>> }).content : []);
    const children: unknown[] = [];
    const hasVisible = content.some((b) => (b.type === "text" && typeof b.text === "string" && b.text.trim()) || (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()));
    if (hasVisible) children.push(new FakeSpacer());
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        children.push(new FakeMarkdown(block.text));
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        children.push(new FakeMouseRegion(new FakeMarkdown(block.thinking), () => ({ handled: true })));
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

test("preview lines: rolling tail, incomplete last line, no JSON parsing", () => {
  const content = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行\n第九行未完成";
  const { lines, totalLogicalLines, truncated } = previewLines(content, 8);
  assert.equal(totalLogicalLines, 9);
  assert.equal(truncated, true);
  assert.equal(lines.length, 8);
  assert.equal(lines[0]!.number, 2, "rolling tail starts at 2");
  assert.equal(lines.at(-1)!.text, "第九行未完成");
  // CRLF normalized for display only.
  const crlf = previewLines("a\r\nb", 8);
  assert.equal(crlf.lines[0]!.text, "a");
});

test("lone trailing surrogate is dropped, content unchanged otherwise", () => {
  assert.equal(previewLines("ok", 8).lines[0]!.text, "ok");
  const raw = "emoji \u{1F600}";
  assert.equal(previewLines(raw, 8).lines[0]!.text, raw);
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


test("thinking timing projects onto textRunPlan and closes on phase transition", () => {
  const state = new TranscriptState();
  const messageObj = { role: "assistant", content: [] as Array<Record<string, unknown>> };
  state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
  const key = state.messageKeyFor({ role: "assistant", content: [] }, messageObj);
  messageObj.content = [{ type: "thinking", thinking: "hmm" }];
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const openPlan = state.textRunPlan(key);
  assert.ok(openPlan, "plan exists while open");
  assert.equal(openPlan!.thinkingEnded, false);
  assert.ok(openPlan!.thinkingMs !== undefined);
  // Phase transition: text after thinking closes the interval.
  messageObj.content = [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Answer." }];
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const closedPlan = state.textRunPlan(state.messageKeyFor(messageObj, messageObj));
  assert.ok(closedPlan, "sealed plan exists");
  assert.equal(closedPlan!.thinkingEnded, true);
});

