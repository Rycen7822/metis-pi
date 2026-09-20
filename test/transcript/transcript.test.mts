// Transcript regression suite: stable separator plans (survive rebuilds), the
// assistant coordination layer (separator + thinking rail), exploration
// grouping with group-total refresh, write live preview, DIM span semantics,
// the thinking visibility policy and the peek window.
//
// The separator/rail/policy tests go through the REAL coordination function
// (installTranscriptDecorations on a fake AssistantMessageComponent that
// mirrors the host rebuild semantics), not through hand-injected plans.
// host-surface.test.mjs anchors the same behaviors on the REAL host classes.

import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptState, assistantHasVisibleThinking, renderedThinkingRuns } from "../../src/transcript-state.ts";
import { installTranscriptDecorations } from "../../src/transcript-adapter.ts";
import { thoughtSummaryText } from "../../src/thinking-summary.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { renderWritePreview } from "../../src/write-preview.ts";
import { styleToolOutputLine } from "../../src/output-style.ts";
import type { ThinkingView, ThinkingViewControl } from "../../src/thinking-view.ts";
import { theme, FakeText } from "../helpers.mjs";

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

// ---------------------------------------------------------------------------
// A. separator persistence through rebuilds
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
  for (let i = 1; i <= 100; i++) {
    messageObj.content = [{ type: "text", text: `delta stream ${i}` }];
    component.updateContent(messageObj);
    state.apply({ type: "message_update", message: JSON.parse(JSON.stringify({ role: "assistant", content: messageObj.content })) }, messageObj);
    assert.equal(countSeps(component), 1, `update ${i}: exactly one separator`);
  }
});

test("two separate assistant messages after one tool: one separator, then none", () => {
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
  ])[1]!.runIndex, 1, "an EMPTY text block still breaks the run (host loop)");
});

// ---------------------------------------------------------------------------
// C. exploration grouping + group-total refresh
// ---------------------------------------------------------------------------

function driveSerialReads(state: TranscriptState, prefix: string) {
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

test("boundaries: bash/foreign/failed/visible-thinking split the group", () => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_start", toolCallId: "sh", toolName: "bash" });
  assert.equal(state.explorationPlan("sh"), undefined);
  assert.notEqual(state.explorationPlan("t2")?.groupId, state.explorationPlan("a")?.groupId);
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true });
  assert.equal(state.groupOpen("a"), false);
});

// ---------------------------------------------------------------------------
// D. write live preview (bounded rolling tail)
// ---------------------------------------------------------------------------

test("renderWritePreview: bounded rows, dim stage label, no success green", () => {
  const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const layout = { wrap: (t: string, _w: number) => [t], visibleWidth: (t: string) => t.length };
  const out = renderWritePreview(content, {
    width: 80, stage: "receiving-arguments", expanded: false,
    theme, colorLevel: { kind: "truecolor" }, layout, gutter: "  │ ",
  });
  assert.ok(out.length <= 12, `max 12 rows, got ${out.length}`);
  assert.match(out[0]!, /Receiving content · preview, not yet committed/);
  assert.match(out[0]!, /\x1b\[2m/, "stage label dimmed");
  assert.doesNotMatch(out.join("\n"), /Added|Edited|Written/);
  // Expanded shows everything.
  const expandedOut = renderWritePreview(content, {
    width: 80, stage: "receiving-arguments", expanded: true,
    theme, colorLevel: { kind: "truecolor" }, layout, gutter: "  │ ",
  });
  assert.match(expandedOut.join("\n"), /line 30/);
});

// ---------------------------------------------------------------------------
// E. DIM semantics (Codex Modifier::DIM over colored tool output)
// ---------------------------------------------------------------------------

test("DIM: source colors survive, resets re-acquire DIM, RGB parameters are not misread", () => {
  const opts = { dim: true, colorLevel: { kind: "truecolor" } } as const;
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

// ---------------------------------------------------------------------------
// F. thinking run clocks + visibility policy (auto-collapse via the HOST's
// thinkingVisibilityOverrides, applied once per transition; native click
// toggle stays in charge; duration labels only on ended runs).
// ---------------------------------------------------------------------------

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
  const handle = installTranscriptDecorations({
    state,
    toolPrototype: undefined,
    assistantPrototype: FakeAssistantComponent.prototype as unknown as object,
    makeSeparator: () => new FakeMarkdown("─".repeat(80)),
    makeSpacer: () => new FakeSpacer(),
    makeRail: (child) => createTestRail(child),
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
  return { handle, summaries };
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

// --- the peek window: policy integration through the real coordinator -------

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
  const clickables: TestClickable[] = [];
  const handle = installTranscriptDecorations({
    state,
    toolPrototype: undefined,
    assistantPrototype: FakeAssistantComponent.prototype as unknown as object,
    makeSeparator: () => new FakeMarkdown("─".repeat(80)),
    makeSpacer: () => new FakeSpacer(),
    makeRail: (child) => createTestRail(child),
    makePeek: (input) => ({
      kind: "peek",
      wrapped: input.inner,
      control: input.control,
      windowLines: input.windowLines,
      onScroll: input.onScroll,
    }),
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
    makeThoughtSummary: (input) => new FakeText(thoughtSummaryText(input.durationMs)),
    isCollapsedLabel: (node) => node instanceof FakeText,
    enabled: () => true,
  });
  activePolicyHandle = handle;
  return { handle, clickables };
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

test("peek: the completion fold happens once, so a later choice survives rebuilds", () => {
  let clock = 1_000;
  const state = new TranscriptState(() => clock);
  setupWithPeek(state, { streaming: "peek", completed: "collapsed", peekLines: 6 });
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
