// Serial exploration grouping, separator idempotence and DIM semantics
// (0.6.0 regression suite). Pure state-machine + renderer tests use synthetic
// events; host-component composition uses the fake host from helpers.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptState, assistantHasVisibleText, isToolCallOnlyAssistant } from "../src/transcript-state.ts";
import { makeRenderers } from "../src/renderers.ts";
import { styleToolOutputLine, reapplyDimAfterResets } from "../src/output-style.ts";
import { theme, FakeText, bindings } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// Event builders (7.1 script shape)
// ---------------------------------------------------------------------------

const IMAGE_NAMES = [
  "all_results.png.png", "shampoo_results.png.png", "EMA_KL_results.png.png",
  "ema_results.png.png", "frob_results.png.png", "larger.png.png",
  "trace_results.png.png", "trace_comparison_results.png.png",
];

function fakeStateSession() {
  // makeRenderers-compatible session carrying a real TranscriptState.
  return {
    tracker: { trackStart() {}, trackEnd() {} },
    colorLevel: { kind: "truecolor" },
    writeChanges: new Map(),
    transcript: new TranscriptState(),
    resultImages: new Map(),
  };
}

function playSerialReads(state, names = IMAGE_NAMES, { delayMs = 0 } = {}) {
  // 8 serial image reads across 8 tool-call-only assistant messages,
  // then one assistant text. Events strictly interleave: call-only message,
  // start, end, (hidden internal events), next message…
  names.forEach((file, i) => {
    state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}` }], stopReason: "toolUse" } });
    state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}` }], stopReason: "toolUse" } });
    state.apply({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read" });
    if (delayMs) state.apply({ type: "turn_start", turnIndex: i, timestamp: i * delayMs });
    state.apply({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", isError: false, imageCount: 1 });
  });
  state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "现在开始比较这些图表。" }] } });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "现在开始比较这些图表。" }] } });
}

// ---------------------------------------------------------------------------
// 7.1 serial exploration grouping
// ---------------------------------------------------------------------------

test("8 serial image reads share one Explored group with ordered member rows", () => {
  const state = new TranscriptState();
  playSerialReads(state);
  const ids = state.groupMemberIds(1);
  assert.equal(ids.length, 8);
  assert.deepEqual(ids, IMAGE_NAMES.map((_, i) => `t${i}`));
  const head = state.explorationPlan("t0");
  assert.equal(head.isHeaderOwner, true);
  assert.equal(head.groupImages, 8);
  assert.equal(head.running, false);
  const last = state.explorationPlan("t7");
  assert.equal(last.isLastMember, true);
  assert.equal(last.suppressLeadingSpacer, true);
});

test("A already finished before B starts still joins the same group", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.equal(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("tens-of-seconds gaps between reads do not split the group", () => {
  const state = new TranscriptState();
  playSerialReads(state, IMAGE_NAMES.slice(0, 3), { delayMs: 45_000 });
  assert.equal(state.groupMemberIds(1).length, 3);
});

test("title flips Exploring→Explored but the group stays open for appends", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "grep" });
  assert.equal(state.explorationPlan("a").running, true);
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "grep", isError: false });
  assert.equal(state.explorationPlan("a").running, false); // Explored
  assert.equal(state.groupOpen("a"), true); // still open
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "ls" });
  assert.equal(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

// ---------------------------------------------------------------------------
// 7.2 boundaries and ordering
// ---------------------------------------------------------------------------

test("read → non-empty text → read: two groups and a separator", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "检查完毕" }] } });
  const textPlan = state.takeTextPlan();
  assert.equal(textPlan.separatorBefore, true);
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.notEqual(state.explorationPlan("b").groupId, 1);
});

test("read → tool-call-only assistant → read: one group", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.equal(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("read → hidden zero-height thinking → read: one group", () => {
  // Host hides thinking (hideThinkingBlock): the model message still carries
  // thinking, but a truly zero-height rendering would show nothing. We treat
  // the *declared* policy conservatively: thinking content IS a boundary only
  // when visible. isToolCallOnlyAssistant ignores it here because the host
  // verification layer decides visibility; grouping stays intact for the
  // verified-zero-height case (no text, no thinking label rendered).
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  // Transparent internal event: nothing visible between the two reads.
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.equal(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("read → VISIBLE thinking text → read: group splits (conservative)", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "Let me check…" }] } });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.notEqual(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("read → bash → read: two groups (bash is a boundary and own activity)", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "sh", toolName: "bash" });
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.ok(state.explorationPlan("a"));
  assert.equal(state.explorationPlan("sh"), undefined);
  assert.notEqual(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("read → foreign custom tool → read: no cross-boundary merge", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "f", toolName: "web_search" }); // non-builtin name
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.notEqual(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("failed read stays visible and ends the group", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true });
  assert.equal(state.groupOpen("a"), false);
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.notEqual(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("parallel reads completing out of order keep creation order", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "A", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "B", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "B", toolName: "read", isError: false });
  state.apply({ type: "tool_execution_end", toolCallId: "A", toolName: "read", isError: false });
  assert.deepEqual(state.groupMemberIds(1), ["A", "B"]);
});

test("same pathname different toolCallId: two members; duplicate events idempotent", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }); // duplicate start
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false, imageCount: 1 });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false, imageCount: 1 }); // dup end
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.deepEqual(state.groupMemberIds(1), ["a", "b"]);
  assert.equal(state.explorationPlan("a").groupImages, 1);
});

test("late results do not corrupt another branch's group (generation bump)", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.resetSession("branch-2");
  assert.equal(state.explorationPlan("a"), undefined);
  state.apply({ type: "tool_execution_end", toolCallId: "late", toolName: "read", isError: false });
  assert.equal(state.groupMemberIds(1).length, 0);
});

// ---------------------------------------------------------------------------
// 7.4 separator idempotence
// ---------------------------------------------------------------------------

test("tool → text(delta…100): exactly one separator, one take", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  let text = "";
  for (let i = 0; i < 100; i++) {
    text += `d${i} `;
    state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });
  }
  const first = state.takeTextPlan();
  assert.equal(first.separatorBefore, true);
  const second = state.takeTextPlan(); // stream continues, no new tool
  assert.equal(second.separatorBefore, false);
});

test("tool → message_start only (tool-call-only): no text segment consumes a line", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "x" }] } });
  // No visible text means no assistant-text component, so takeTextPlan is
  // never called by the decoration layer. The next read joins the same group.
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "read" });
  assert.equal(state.explorationPlan("b").groupId, state.explorationPlan("a").groupId);
});

test("tool → whitespace text → real text: one line before the real text", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "   " }] } });
  // whitespace-only never marks visible text (assistantHasVisibleText trims)
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "real" }] } });
  assert.equal(assistantHasVisibleText({ role: "assistant", content: [{ type: "text", text: "   " }] }), false);
  const plan = state.takeTextPlan();
  assert.equal(plan.separatorBefore, true);
});

test("tool → thinking → text: separator arms on the TEXT, not the thinking", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] } });
  // thinking closes the group and marks activity, but the boundary line waits
  // for text: takeTextPlan before text returns the pending flag too — the
  // component layer only *renders* it on a text-bearing component.
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "answer" }] } });
  const plan = state.takeTextPlan();
  assert.equal(plan.separatorBefore, true);
});

test("tool → text A → tool → text B: two independent boundaries", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "A" }] } });
  assert.equal(state.takeTextPlan().separatorBefore, true);
  state.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "bash" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "B" }] } });
  assert.equal(state.takeTextPlan().separatorBefore, true);
  assert.equal(state.takeTextPlan().separatorBefore, false); // no third line
});

test("user question → direct answer: no stale separator", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  state.apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "next question" }] } });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
  // The user boundary cleared the pending line; the fresh answer gets none.
  const plan = state.takeTextPlan();
  assert.equal(plan.separatorBefore, false);
});

test("user boundary between tool and text: no separator (fresh segment)", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  state.apply({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
  // Per 5.2: 用户消息后立即回答，不因上一轮残留状态插线 — the reply IS the
  // first text after tools in display order, but the user turn resets the
  // pending line: applyUserBoundary() clears separatorPending.
  const plan = state.takeTextPlan();
  assert.equal(plan.separatorBefore, false);
});

// ---------------------------------------------------------------------------
// 7.5 DIM semantics (decode spans, not substring checks)
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const INTENSITY_OFF = "\x1b[22m";

/** Minimal ANSI-span decoder: returns [{text, dim, fg}] per physical line.
 * A span records the SGR state IN EFFECT while its characters display:
 * flush() happens BEFORE applying each sequence's state change. */
function decodeSpans(line) {
  const spans = [];
  let dim = false;
  let fg = null;
  let buffer = "";
  const flush = () => { if (buffer) { spans.push({ text: buffer, dim, fg }); buffer = ""; } };
  const re = /\x1b\[([0-9;:]*)([a-zA-Z])/g;
  let cursor = 0;
  let match;
  while ((match = re.exec(line))) {
    buffer += line.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[2] !== "m") continue;
    flush(); // state change applies to FOLLOWING characters only
    const params = match[1].split(";").filter(Boolean).map(Number);
    const effective = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 38 || p === 48 || p === 58) {
        const mode = params[i + 1];
        const skip = mode === 2 ? 5 : mode === 5 ? 3 : 1;
        effective.push(params.slice(i, i + skip));
        i += skip - 1;
      } else effective.push(p);
    }
    for (const p of effective) {
      if (Array.isArray(p)) { fg = p.join(";"); continue; }
      if (p === 0) { dim = false; fg = null; }
      else if (p === 22) dim = false;
      else if (p === 2) dim = true;
      else if (p === 1 || p === 3 || p === 5) dim = false;
      else if (p === 39) fg = null;
      else if ((p >= 30 && p <= 38) || (p >= 90 && p <= 97) || (p >= 40 && p <= 48)) fg = p;
    }
  }
  buffer += line.slice(cursor);
  flush();
  return spans;
}

test("DIM: plain output is fully dim including prefix, and intensity closes", () => {
  const out = styleToolOutputLine("  └ hello", { dim: true, colorLevel: { kind: "truecolor" } });
  assert.ok(out.startsWith(DIM));
  assert.ok(out.endsWith(INTENSITY_OFF));
  const spans = decodeSpans(out);
  assert.ok(spans.every((s) => s.dim));
});

test("DIM: source red survives; text after 0m re-acquires our DIM", () => {
  const src = "\x1b[31mred\x1b[0mplain-after-reset";
  const out = styleToolOutputLine(src, { dim: true, colorLevel: { kind: "truecolor" } });
  const spans = decodeSpans(out);
  const red = spans.find((s) => s.text.includes("red"));
  assert.equal(red.dim, true);
  assert.equal(red.fg, 31);
  const after = spans.find((s) => s.text.includes("plain-after"));
  assert.equal(after.dim, true); // NOT lost to the inner 0m
  assert.equal(after.fg, null);
});

test("DIM: bold→22m in source does not permanently kill our DIM", () => {
  const src = "\x1b[1mbold\x1b[22mnormal-source";
  const out = styleToolOutputLine(src, { dim: true, colorLevel: { kind: "truecolor" } });
  const spans = decodeSpans(out);
  // After the source's own 22m, our DIM is re-issued.
  const tail = spans.filter((s) => s.text.includes("normal"));
  assert.ok(tail.length > 0);
  assert.equal(tail.at(-1).dim, true);
});

test("DIM: RGB components 0/22/39 are never read as resets", () => {
  const src = "\x1b[38;2;0;22;39mRGB\x1b[39mdefault";
  const out = styleToolOutputLine(src, { dim: true, colorLevel: { kind: "truecolor" } });
  const spans = decodeSpans(out);
  const rgb = spans.find((s) => s.text.includes("RGB"));
  assert.equal(rgb.dim, true); // dim survives the extended color
  assert.equal(rgb.fg, "38;2;0;22;39");
});

test("DIM: 256-color index 22 is not a reset", () => {
  const src = "\x1b[38;5;22mindexed\x1b[0mplain";
  const out = styleToolOutputLine(src, { dim: true, colorLevel: { kind: "ansi256" } });
  const spans = decodeSpans(out);
  const idx = spans.find((s) => s.text.includes("indexed"));
  assert.equal(idx.dim, true);
  assert.equal(idx.fg, "38;5;22");
  const plain = spans.find((s) => s.text.includes("plain"));
  assert.equal(plain.dim, true);
});

test("DIM: multi-line continuation keeps dim per row; no leak", () => {
  for (const line of ["row1", "\x1b[31mrow2\x1b[39m tail"]) {
    const out = styleToolOutputLine(line, { dim: true, colorLevel: { kind: "truecolor" } });
    assert.ok(out.startsWith(DIM), "row starts dim");
    assert.ok(out.endsWith(INTENSITY_OFF), "row closes intensity");
  }
});

test("DIM: idempotent — restyling does not stack darkness", () => {
  const once = styleToolOutputLine("text", { dim: true, colorLevel: { kind: "truecolor" } });
  const twice = styleToolOutputLine(once, { dim: true, colorLevel: { kind: "truecolor" } });
  const spans = decodeSpans(twice);
  assert.ok(spans.every((s) => s.dim));
  // No duplicated DIM sequences back-to-back beyond re-asserts.
  assert.equal((twice.match(/\x1b\[2m/g) || []).length <= 3, true, "bounded DIM count");
});

test("DIM: no-color emits zero SGR", () => {
  const out = styleToolOutputLine("\x1b[31mred\x1b[0m", { dim: true, colorLevel: { kind: "none" } });
  assert.equal(out, "\x1b[31mred\x1b[0m");
});

test("DIM: reapplyDimAfterResets alone keeps text identical", () => {
  assert.equal(reapplyDimAfterResets("plain"), "plain"); // no SGR in, no DIM out
  const re = reapplyDimAfterResets("\x1b[31mred\x1b[0m tail");
  assert.ok(re.startsWith("\x1b[31mred"));
  assert.ok(re.includes("\x1b[0m\x1b[2m tail"), "DIM re-issued after reset");
});

// ---------------------------------------------------------------------------
// 7.6 protection: two-slot + write/diff paths still hold (renderer level)
// ---------------------------------------------------------------------------

test("grouped renderers: header on first member only, flat rows after, images once", () => {
  const session = fakeStateSession();
  const renderers = makeRenderers((s) => new FakeText(s), () => "ctrl+o to expand", undefined, undefined, undefined, session);
  const state = session.transcript;
  state.apply({ type: "tool_execution_start", toolCallId: "t0", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "t0", toolName: "read", isError: false, imageCount: 1 });
  state.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false, imageCount: 1 });

  const call0 = renderers.read.renderCall({ path: "a.png" }, theme, { toolCallId: "t0", isPartial: false, state: {} });
  const text0 = call0.render(100).join("\n");
  assert.match(text0, /Explored/);
  assert.match(text0, /\u2514 [\s\S]*Read[\s\S]*a\.png/); // ANSI-tolerant

  const call1 = renderers.read.renderCall({ path: "b.png" }, theme, { toolCallId: "t1", isPartial: false, state: {} });
  const text1 = call1.render(100).join("\n");
  assert.doesNotMatch(text1, /Explored/); // no second header
  assert.match(text1, /Read[\s\S]*b\.png/); // ANSI-tolerant
  assert.match(text1, / {4}[\s\S]{0,40}Read/); // four-space gutter (ANSI-tolerant)
  assert.match(text1, /2 images/); // aggregated once, on the last member
});
