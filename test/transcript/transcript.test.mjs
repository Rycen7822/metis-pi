// Transcript regression suite: stable separator plans (survive rebuilds), the
// assistant coordination layer (separator + thinking rail), exploration
// grouping with group-total refresh, write live preview, DIM span semantics,
// the thinking visibility policy and the peek window.
//
// Real coordinator + real host rebuilds; only the rail/peek painters are stubs.

import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { TranscriptState, assistantHasVisibleThinking, renderedThinkingRuns } from "../../src/transcript-state.ts";
import { installTranscriptDecorations } from "../../src/transcript-adapter.ts";
import { thoughtSummaryText } from "../../src/thinking-summary.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { renderWritePreview } from "../../src/write-preview.ts";
import { styleToolOutputLine } from "../../src/output-style.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { copyFrame, installCopyPrototypes, select } from "../helpers/ui-fixtures.mjs";
import { theme, FakeText, sessionStub } from "../helpers.mjs";

initTheme("dark", false);

const IMAGE_NAMES = [
  "all_results.png.png", "shampoo_results.png.png", "EMA_KL_results.png.png",
  "ema_results.png.png", "frob_results.png.png", "larger.png.png",
  "trace_results.png.png", "trace_comparison_results.png.png",
];

test("message identity and thinking controls survive finalization, duplicate ends and late updates", () => {
  let now = 10;
  const state = new TranscriptState(() => now);
  const source = { role: "assistant", content: [{ type: "thinking", thinking: "working" }] };
  state.apply({ type: "message_start", message: source }, source);
  state.apply({ type: "message_update", message: source }, source);
  const key = state.identityOf(source);
  let cancelled = 0;
  const control = { cancel: () => { cancelled++; } };
  state.thinkingViewControl(key, 0, () => control);
  now = 30;
  state.apply({ type: "message_end", message: source }, source);
  assert.equal(state.identityOf(source), key);
  assert.equal(state.thinkingRunPlan(key, 0)?.thinkingMs, 20);
  now = 60;
  state.apply({ type: "message_end", message: source }, source);
  state.apply({ type: "message_update", message: source }, source);
  assert.equal(state.thinkingRunPlan(key, 0)?.thinkingMs, 20);
  assert.equal(state.thinkingViewControl(key, 0, () => { throw new Error("control replaced"); }), control);
  assert.equal(state.registerFinalizedMessage(structuredClone(source), false), key);
  state.resetSession("next");
  assert.equal(cancelled, 1);
  assert.equal(state.identityOf(source), undefined);
  state.apply({ type: "message_start", message: source }, source);
  assert.notEqual(state.identityOf(source), key, "an object reused after a session reset gets a fresh identity");
});

/** Count actual native rebuilds, including the coordinator's one extra pass. */
class Assistant extends AssistantMessageComponent {
  updateCalls = 0;
  constructor(message) {
    super();
    if (message) this.updateContent(message);
  }
  updateContent(message, isStreaming = this.isStreaming) {
    this.updateCalls += 1;
    super.updateContent(message, isStreaming);
  }
}

/** One lease per test; the native override map and click handler stay in charge. */
function setup(t, state, policy, extra = {}) {
  const summaries = [];
  const handle = installTranscriptDecorations({
    state,
    assistantPrototype: Assistant.prototype,
    makeSeparator: () => new Text("─".repeat(80), 0, 0),
    makeSpacer: () => new Spacer(1),
    makeRail: (child) => ({
      railId: true, wrapped: child,
      render(width) { return child.render(width); },
    }),
    thinkingPolicy: policy ? () => ({ ...policy, peekLines: 6 }) : undefined,
    makeThoughtSummary: (input) => {
      const label = new Text(thoughtSummaryText(input.durationMs), 0, 0);
      summaries.push(label);
      return label;
    },
    isCollapsedLabel: (node) => node instanceof Text,
    enabled: () => true,
    ...extra,
  });
  t.after(() => handle.dispose());
  return { handle, summaries };
}

function streamingAssistant(state, content = []) {
  const message = { role: "assistant", content };
  state.apply({ type: "message_start", message: { ...message } }, message);
  const component = new Assistant();
  return {
    message, component,
    update(next = message.content) {
      message.content = next;
      state.apply({ type: "message_update", message: { ...message } }, message);
      component.updateContent(message, true);
    },
  };
}

const countSeps = (component) =>
  component.contentContainer.children.filter((c) => c.text === "─".repeat(80)).length;

test("separator survives 100 streaming updates of the SAME logical message", (t) => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  const { handle } = setup(t, state);
  assert.equal(handle.features.find((f) => f.name === "separator")?.installed, true);
  // The host streams one AssistantMessage object; the decoration layer sees
  // message_update → object stays the same → identity stays the same.
  const messageObj = { role: "assistant", content: [] };
  const component = new Assistant(messageObj);
  for (let i = 1; i <= 100; i++) {
    messageObj.content = [{ type: "text", text: `delta stream ${i}` }];
    component.updateContent(messageObj);
    state.apply({ type: "message_update", message: JSON.parse(JSON.stringify({ role: "assistant", content: messageObj.content })) }, messageObj);
    assert.equal(countSeps(component), 1, `update ${i}: exactly one separator`);
  }
});

test("two separate assistant messages after one tool: one separator, then none", (t) => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  setup(t, state);
  const objA = { role: "assistant", content: [{ type: "text", text: "first" }] };
  const compA = new Assistant(objA);
  state.apply({ type: "message_update", message: { role: "assistant", content: objA.content } }, objA);
  compA.updateContent(objA);
  assert.equal(countSeps(compA), 1);
  // Second message: lastNode is now assistant-text → NO separator.
  const objB = { role: "assistant", content: [{ type: "text", text: "second" }] };
  state.apply({ type: "message_start", message: { role: "assistant", content: objB.content } }, objB);
  state.apply({ type: "message_update", message: { role: "assistant", content: objB.content } }, objB);
  const compB = new Assistant(objB);
  compB.updateContent(objB);
  assert.equal(countSeps(compB), 0, "second message has no separator (no new tools)");
});

test("rail wraps thinking runs, never text runs", (t) => {
  const state = new TranscriptState();
  setup(t, state);
  const messageObj = { role: "assistant", content: [
    { type: "thinking", thinking: "step one" },
    { type: "text", text: "plain English with the word Thinking inside" },
    { type: "thinking", thinking: "step two" },
  ] };
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  const component = new Assistant(messageObj);
  component.updateContent(messageObj);
  const children = component.contentContainer.children;
  const wrapped = children.filter((c) => c instanceof MouseRegion && "railId" in c.child);
  assert.equal(wrapped.length, 2, "both thinking runs wrapped");
  const textChild = children.find((c) => c instanceof Markdown && c.text.includes("Thinking"));
  assert.ok(textChild, "text stays unwrapped");
  // Plain English is never typed as thinking (semantic typing only).
  assert.equal(assistantHasVisibleThinking({ role: "assistant", content: [{ type: "text", text: "Thinking about it." }] }), false);
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
  ])[1].runIndex, 1, "an EMPTY text block still breaks the run (host loop)");
});

function driveSerialReads(state, prefix) {
  IMAGE_NAMES.forEach((_, i) => {
    state.apply({ type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: `${prefix}${i}` }] } });
    state.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: `${prefix}${i}` }] } });
    state.apply({ type: "tool_execution_start", toolCallId: `${prefix}${i}`, toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: `${prefix}${i}`, toolName: "read", isError: false, imageCount: 1 });
  });
}

test("8 serial reads: one group, ordered members, totals refresh on append", () => {
  const state = new TranscriptState();
  driveSerialReads(state, "t");
  const ids = state.groupMemberIds(1);
  assert.deepEqual(ids, IMAGE_NAMES.map((_, i) => `t${i}`));
  // Group total from the CURRENT plan is stable regardless of member age:
  const headPlan = state.explorationPlan("t0");
  assert.equal(headPlan?.groupImages, 8);
  // Dirty views include every member after appends (renderer refresh hints).
  const dirty = state.takeDirtyViews();
  assert.ok(dirty.some((k) => k.startsWith("member:")), "member refresh hints present");
});

test("renderers: only the CURRENT last member carries the aggregated notice", () => {
  const session = { ...sessionStub, transcript: new TranscriptState() };
  const renderers = makeRenderers((s) => new FakeText(s), () => "ctrl+o to expand", undefined, undefined, undefined, undefined, session);
  driveSerialReads(session.transcript, "img");
  // Render EVERY member's call row (both slots, no injected plans).
  for (let i = 0; i < 8; i++) {
    const ctx = { toolCallId: `img${i}`, isPartial: false, state: {}, args: { path: `figures/${IMAGE_NAMES[i]}` } };
    const call = renderers.read.renderCall({ path: `figures/${IMAGE_NAMES[i]}` }, theme, ctx);
    const text = call.render(100).join("\n");
    const plan = session.transcript.explorationPlan(`img${i}`);
    const showsTotal = plan?.isLastMember === true ? /8 images/.test(text) : !/images/.test(text);
    assert.ok(showsTotal, `member ${i}: total only on the current last member`);
    assert.doesNotMatch(text, /1 image\b/, `member ${i}: no per-member 1 image`);
  }
});

test("adjacent successful reads remain in one exploration group", () => {
  const state = new TranscriptState();
  for (const id of ["before", "after"]) {
    state.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false });
  }
  const before = state.explorationPlan("before");
  const after = state.explorationPlan("after");
  assert.ok(before);
  assert.ok(after);
  assert.equal(before.groupId, after.groupId);
});

for (const [name, boundary] of [
  ["bash", (state) => state.apply({ type: "tool_execution_start", toolCallId: "boundary", toolName: "bash" })],
  ["foreign tool", (state) => state.apply({ type: "tool_execution_start", toolCallId: "boundary", toolName: "unrecognized_tool" })],
  ["failed read", (state) => {
    state.apply({ type: "tool_execution_start", toolCallId: "boundary", toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: "boundary", toolName: "read", isError: true });
  }],
  ["visible thinking", (state) => state.apply({ type: "message_update", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "working" }],
  } })],
]) {
  test(`${name} separates two real read groups`, () => {
    const state = new TranscriptState();
    state.apply({ type: "tool_execution_start", toolCallId: "before", toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: "before", toolName: "read", isError: false });
    boundary(state);
    state.apply({ type: "tool_execution_start", toolCallId: "after", toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: "after", toolName: "read", isError: false });
    const before = state.explorationPlan("before");
    const after = state.explorationPlan("after");
    assert.ok(before);
    assert.ok(after);
    assert.notEqual(before.groupId, after.groupId);
  });
}

test("renderWritePreview: bounded rows, dim stage label, no success green", () => {
  const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const layout = { wrap: (t) => [t], visibleWidth: (t) => t.length };
  const options = {
    width: 80, stage: "receiving-arguments",
    theme, colorLevel: { kind: "truecolor" }, layout, gutter: "  │ ",
  };
  const out = renderWritePreview(content, { ...options, expanded: false });
  assert.ok(out.length <= 12, `max 12 rows, got ${out.length}`);
  assert.match(out[0], /Receiving content · preview, not yet committed/);
  assert.match(out[0], /\x1b\[2m/, "stage label dimmed");
  assert.doesNotMatch(out.join("\n"), /Added|Edited|Written/);
  // Expanded shows everything.
  const expandedOut = renderWritePreview(content, { ...options, expanded: true });
  assert.match(expandedOut.join("\n"), /line 30/);
});

test("DIM: source colors survive, resets re-acquire DIM, RGB parameters are not misread", () => {
  const opts = { dim: true, colorLevel: { kind: "truecolor" } };
  const red = styleToolOutputLine("\x1b[31mred\x1b[0mplain-after-reset", opts);
  assert.ok(red.startsWith("\x1b[2m") && red.endsWith("\x1b[22m"), "wrapped in DIM…INTENSITY_RESET");
  assert.ok(red.includes("\x1b[31m"), "source color survives");
  assert.ok(red.includes("\x1b[0m\x1b[2m"), "DIM re-acquired after the reset");
  // 38;2;0;22;39: the 0/22/39 are RGB components, never intensity commands.
  const rgb = styleToolOutputLine("\x1b[38;2;0;22;39mRGB\x1b[39mdefault", opts);
  assert.ok(rgb.includes("\x1b[38;2;0;22;39m"), "RGB sequence kept intact");
  // Restyling does not undo the dim (idempotent outcome, whatever the codes).
  const twice = styleToolOutputLine(styleToolOutputLine("text", opts), opts);
  assert.ok(twice.startsWith("\x1b[2m") && twice.endsWith("\x1b[22m"));
  // no-color / dim-off: input returned verbatim.
  assert.equal(styleToolOutputLine("\x1b[31mred\x1b[0m", { dim: true, colorLevel: { kind: "none" } }), "\x1b[31mred\x1b[0m");
  assert.equal(styleToolOutputLine("plain", { dim: false, colorLevel: { kind: "truecolor" } }), "plain");
});

test("per-run plans: clock starts once at first text, closes on the text boundary", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const messageObj = { role: "assistant", content: [] };
  state.apply({ type: "message_start", message: { role: "assistant", content: [] } }, messageObj);
  messageObj.content = [{ type: "thinking", thinking: "hmm" }];
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  let plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.ok(plan, "run plan exists while streaming");
  assert.equal(plan.ended, false);
  assert.equal(plan.startedAt, 1_000);
  clock += 7_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.equal(plan.startedAt, 1_000, "cumulative updates never reset the start clock");
  messageObj.content = [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Answer." }];
  clock += 2_000;
  state.apply({ type: "message_update", message: { role: "assistant", content: messageObj.content } }, messageObj);
  plan = state.thinkingRunPlan(state.messageKeyFor(messageObj), 0);
  assert.equal(plan.ended, true, "a non-thinking block after the run closes its clock");
  assert.equal(plan.endedAt, 10_000);
  assert.equal(plan.thinkingMs, 9_000);
  // textRunPlan is separator-only now (single timing source lives per run).
  const textPlan = state.textRunPlan(state.messageKeyFor(messageObj));
  assert.equal(textPlan?.thinkingMs, undefined);
  assert.equal("thinkingEnded" in (textPlan ?? {}), false);
});

const regionsOf = (component) => component.contentContainer.children.filter((c) => c instanceof MouseRegion);

/** Inner display node of a region, unwrapping a rail wrapper when present. */
function innerOf(region) {
  const child = region.child;
  return child && typeof child === "object" && "wrapped" in child ? child.wrapped : region.child;
}

const summaryLabels = (component, summaries) =>
  regionsOf(component)
    .map((region) => region.child)
    .filter((child) => summaries.includes(child));

const click = (region) => {
  region.handleMouse({ type: "click", button: "left" });
};

test("policy: streaming stays expanded, auto-collapse fires ONCE with the run duration", (t) => {
  let clock = 5_000;
  const state = new TranscriptState(() => clock);
  const { handle, summaries } = setup(t, state, { streaming: "full", completed: "collapsed" });
  const { component, message, update } = streamingAssistant(state);
  update([{ type: "thinking", thinking: "deep thought" }]);
  assert.ok(innerOf(regionsOf(component)[0]) instanceof Markdown, "expanded while streaming");
  assert.equal(component.thinkingVisibilityOverrides.size, 0, "full policy needs no override for new runs");

  clock = 12_000;
  const before = component.updateCalls;
  update([{ type: "thinking", thinking: "deep thought" }, { type: "text", text: "Answer." }]);
  assert.equal(component.updateCalls - before, 2, "exactly ONE extra host rebuild on the transition");
  const labels = summaryLabels(component, summaries);
  assert.equal(labels.length, 1, "collapsed run shows the duration summary");
  assert.equal(labels[0].text, "Thought for 7s");

  const steady = component.updateCalls;
  component.updateContent(message, true);
  assert.equal(component.updateCalls - steady, 1, "steady updates never re-apply the policy");
  assert.equal(handle.thinkingAutoApplied(), 1, "one applied visibility transition total");

  // Native toggle: click the summary → the full body returns (with rail).
  click(regionsOf(component)[0]);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "host map owns the manual state");
  assert.ok(innerOf(regionsOf(component)[0]).text.includes("deep thought"), "body restored verbatim");
  // Click the expanded body → collapsed again; the policy stays out of the way.
  click(regionsOf(component)[0]);
  assert.equal(summaryLabels(component, summaries).length, 1, "summary restored after second click");
  assert.equal(handle.thinkingAutoApplied(), 1);
});

test("collapsed real thinking copies its label without hidden body; expansion restores the body", (t) => {
  const copySystem = installCopyPrototypes();
  t.after(() => copySystem.dispose());
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  const { summaries } = setup(t, state, { streaming: "full", completed: "collapsed" });
  const { component, update } = streamingAssistant(state);
  const hidden = "SECRET_THINKING_SENTINEL";
  update([{ type: "thinking", thinking: hidden }]);
  clock = 4_000;
  update([{ type: "thinking", thinking: hidden }, { type: "text", text: "Answer." }]);
  const label = summaryLabels(component, summaries)[0];
  assert.ok(label, "the real assistant rendered a collapsed summary");
  assert.doesNotMatch(component.render(80).join("\n"), /SECRET_THINKING_SENTINEL/);
  const rows = productFor(label.render(80))?.rows;
  assert.ok(rows, "summary Text publishes copy spans");
  const copied = rows.flatMap((row) => row.spans.filter((span) => span.kind !== "decoration").map((span) => span.text ?? "")).join("");
  assert.equal(copied, "Thought for 3s");
  click(regionsOf(component)[0]);
  const body = innerOf(regionsOf(component)[0]);
  assert.match(select(copyFrame(body, 80)).text, /SECRET_THINKING_SENTINEL/);
});

test("policy: two runs collapse independently with their own durations", (t) => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  setup(t, state, { streaming: "full", completed: "collapsed" });
  const { component, message, update } = streamingAssistant(state, [{ type: "thinking", thinking: "run zero" }]);
  update();
  clock = 6_000;
  update([
    { type: "thinking", thinking: "run zero" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "thinking", thinking: "run one" },
  ]);
  assert.equal(regionsOf(component).length, 2, "toolCall keeps two regions");
  assert.equal(regionsOf(component)[0].child.text, "Thought for 5s", "run 0 duration from its own clock");
  assert.ok(innerOf(regionsOf(component)[1]) instanceof Markdown, "run 1 still expanded");

  clock = 9_500;
  update([...message.content, { type: "text", text: "final" }]);
  assert.equal(regionsOf(component)[1].child.text, "Thought for 3s", "run 1 collapses on the text boundary");
  // Clicking run 0 does not disturb run 1.
  click(regionsOf(component)[0]);
  assert.ok(innerOf(regionsOf(component)[0]).text.includes("run zero"), "run 0 expanded");
  assert.ok(regionsOf(component)[1].child instanceof Text, "run 1 stays collapsed");
});

// --- the peek window: policy integration through the real coordinator -------

/** Walk every wrapper layer (click layer, rail, peek window) to the host body. */
function unwrapAll(node) {
  let current = node;
  for (let i = 0; i < 5; i += 1) {
    const wrapped = current?.wrapped;
    if (wrapped === undefined) break;
    current = wrapped;
  }
  return current;
}

/** Unwrap the click layer (always outermost in 0.12.0) and return it. */
function clickableOf(component, index = 0) {
  const child = regionsOf(component)[index].child;
  assert.equal(child.kind, "clickable", "the click layer wraps the whole block");
  return child;
}

test("peek: the completion fold happens once, so a later choice survives rebuilds", (t) => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  setup(t, state, { streaming: "peek", completed: "collapsed" }, {
    makePeek: ({ inner, ...input }) => ({ kind: "peek", wrapped: inner, ...input }),
    makeClickable: ({ inner, ...input }) => ({ kind: "clickable", wrapped: inner, ...input }),
  });
  const { component, message, update } = streamingAssistant(state, [{ type: "thinking", thinking: "run body" }]);
  update();

  // The user double clicks the streaming window: peek → full.
  const streaming = clickableOf(component);
  streaming.control.handleClick({ at: 1_000, x: 4, y: 4 }, { fallback: streaming.fallback, apply: streaming.apply });
  streaming.control.handleClick({ at: 1_080, x: 4, y: 4 }, { fallback: streaming.fallback, apply: streaming.apply });
  assert.equal(streaming.control.userView(), "full", "double click opened the full body");
  assert.notEqual(component.thinkingVisibilityOverrides.get(0), true, "a shown run needs no override entry");
  component.updateContent(message, true);
  assert.ok(unwrapAll(regionsOf(component)[0].child) instanceof Markdown, "full body, no window");

  // The run ends: the completion policy folds it once (the user's shape is dropped).
  clock = 4_000;
  update([...message.content, { type: "text", text: "out" }]);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true, "auto-folded at completion");
  const collapsedChild = clickableOf(component).wrapped;
  assert.ok(collapsedChild instanceof Text, "collapsed label shown");

  // The user opens it again AFTER the run ended: no later rebuild may re-fold it.
  const ended = clickableOf(component);
  ended.control.handleClick({ at: 5_000, x: 4, y: 4 }, { fallback: ended.fallback, apply: ended.apply });
  ended.control.handleClick({ at: 5_080, x: 4, y: 4 }, { fallback: ended.fallback, apply: ended.apply });
  assert.equal(ended.control.userView(), "full", "post-completion choice recorded");
  for (let i = 0; i < 3; i += 1) component.updateContent(message, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "rebuilds keep the run open");
  assert.ok(unwrapAll(regionsOf(component)[0].child) instanceof Markdown, "and keep the full body");
});
