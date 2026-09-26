// Native assistant reconstruction, thinking policy and selection contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { TranscriptState } from "../../src/transcript-state.ts";
import { installTranscriptDecorations } from "../../src/transcript-adapter.ts";
import { thoughtSummaryText } from "../../src/thinking-summary.ts";
import { CodexThinkingRailComponent, CodexThinkingPeekComponent, CodexThinkingClickableComponent } from "../../src/chrome/transcript-components.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { copyFrame, installCopyPrototypes, select } from "../helpers/ui-fixtures.mjs";

initTheme("dark", false);

// A distinct native prototype keeps this file's lease isolated.
class Assistant extends AssistantMessageComponent {
  updateContent(message, isStreaming = this.isStreaming) {
    super.updateContent(message, isStreaming);
  }
}

/** One lease per test; the native override map and click handler stay in charge. */
function setup(t, state, policy, extra = {}) {
  const handle = installTranscriptDecorations({
    state,
    assistantPrototype: Assistant.prototype,
    makeSeparator: () => new Text("─".repeat(80), 0, 0),
    makeSpacer: () => new Spacer(1),
    makeRail: (child) => new CodexThinkingRailComponent(child, { kind: "truecolor" }),
    thinkingPolicy: policy ? () => ({ ...policy, peekLines: 6 }) : undefined,
    makeThoughtSummary: (input) => new Text(thoughtSummaryText(input.durationMs), 0, 0),
    isCollapsedLabel: (node) => node instanceof Text,
    enabled: () => true,
    ...extra,
  });
  t.after(() => handle.dispose());
  return handle;
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

test("separator survives native rebuilds and belongs only to the first message after a tool", (t) => {
  const state = new TranscriptState();
  state.apply({ type: "tool_execution_start", toolCallId: "a", toolName: "read" });
  state.apply({ type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: false });
  const handle = setup(t, state);
  assert.equal(handle.features.find((f) => f.name === "separator")?.installed, true);
  // The host streams one AssistantMessage object; the decoration layer sees
  // message_update → object stays the same → identity stays the same.
  const messageObj = { role: "assistant", content: [] };
  const component = new Assistant(messageObj);
  for (let i = 1; i <= 3; i++) {
    messageObj.content = [{ type: "text", text: `delta stream ${i}` }];
    component.updateContent(messageObj);
    state.apply({ type: "message_update", message: JSON.parse(JSON.stringify({ role: "assistant", content: messageObj.content })) }, messageObj);
    assert.equal(countSeps(component), 1, `update ${i}: exactly one separator`);
  }
  const next = { role: "assistant", content: [{ type: "text", text: "second message" }] };
  state.apply({ type: "message_start", message: next }, next);
  state.apply({ type: "message_update", message: next }, next);
  const second = new Assistant(next);
  second.updateContent(next);
  assert.equal(countSeps(second), 0, "a second message without another tool gets no separator");
});

const regionsOf = (component) => component.contentContainer.children.filter((child) => child instanceof MouseRegion);

const regionText = (region) => region.child.render(80).join("\n");

const click = (region) => {
  region.handleMouse({ type: "click", button: "left" });
};

test("two native runs fold once independently, copy visible content and preserve manual choices", (t) => {
  installCopyPrototypes(t);
  let clock = 5_000;
  const state = new TranscriptState(() => clock);
  setup(t, state, { streaming: "full", completed: "collapsed" });
  const { component, message, update } = streamingAssistant(state);
  update([{ type: "thinking", thinking: "deep thought" }]);
  assert.ok(regionsOf(component)[0].child instanceof CodexThinkingRailComponent, "expanded while streaming");
  assert.equal(component.thinkingVisibilityOverrides.size, 0, "full policy needs no override for new runs");

  clock = 12_000;
  update([
    { type: "thinking", thinking: "deep thought" },
    { type: "toolCall", id: "t1", name: "read" },
    { type: "text", text: "plain English with the word Thinking inside" },
    { type: "thinking", thinking: "second run" },
  ]);
  assert.ok(component.contentContainer.children.some((child) => child instanceof Markdown && child.text.includes("Thinking")),
    "ordinary text stays outside the thinking rail");
  assert.equal(regionsOf(component).length, 2, "tool and text barriers preserve distinct runs");
  assert.ok(regionsOf(component)[1].child instanceof CodexThinkingRailComponent, "second run remains expanded");
  const label = regionsOf(component)[0].child;
  assert.equal(label.text, "Thought for 7s", "collapsed run shows its duration");
  assert.doesNotMatch(component.render(80).join("\n"), /deep thought/, "collapsed body stays hidden");
  const rows = productFor(label.render(80))?.rows;
  assert.ok(rows, "summary Text publishes copy spans");
  const copied = rows.flatMap((row) => row.spans.filter((span) => span.kind !== "decoration").map((span) => span.text ?? "")).join("");
  assert.equal(copied, "Thought for 7s", "copy contains the visible label, never the hidden body");

  clock = 15_500;
  update([...message.content, { type: "text", text: "Answer." }]);
  assert.equal(regionsOf(component)[1].child.text, "Thought for 3s", "second run uses its own clock");

  // Native toggle: click the summary → the full body returns (with rail).
  click(regionsOf(component)[0]);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "host map owns the manual state");
  assert.ok(regionText(regionsOf(component)[0]).includes("deep thought"), "body restored verbatim");
  assert.match(select(copyFrame(regionsOf(component)[0].child, 80)).text, /deep thought/);
  assert.equal(regionsOf(component)[1].child.text, "Thought for 3s", "opening the first run leaves the second collapsed");
  // Click the expanded body → collapsed again; the policy stays out of the way.
  click(regionsOf(component)[0]);
  assert.deepEqual(regionsOf(component).map(({ child }) => child.text), ["Thought for 7s", "Thought for 3s"]);
  component.setHideThinkingBlock(false);
  assert.equal(component.thinkingVisibilityOverrides.size, 0, "global show clears the native override map");
  component.updateContent(message);
  assert.ok(regionsOf(component)[0].child instanceof CodexThinkingRailComponent, "global show restores the native body");
  assert.match(regionText(regionsOf(component)[0]), /deep thought/, "later redraw cannot re-collapse global show");
});

test("native peek gestures open the body, fold once on completion and survive later rebuilds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const state = new TranscriptState(() => Date.now());
  setup(t, state, { streaming: "peek", completed: "collapsed" }, {
    makePeek: ({ inner, control, windowLines, onScroll }) =>
      new CodexThinkingPeekComponent(inner, control, windowLines, (text) => text, onScroll),
    makeClickable: ({ inner, control, fallback, apply }) =>
      new CodexThinkingClickableComponent(inner, control, fallback, apply),
  });
  const body = Array.from({ length: 12 }, (_, i) => `reasoning row ${i}`).join("\n\n");
  const { component, message, update } = streamingAssistant(state, [{ type: "thinking", thinking: body }]);
  const doubleClick = () => {
    const event = { type: "click", button: "left", x: 4, y: 4, screenX: 4, screenY: 4, width: 80, height: 8 };
    clickRegion(event);
    t.mock.timers.tick(80);
    clickRegion(event);
  };
  const clickRegion = (event) => {
    const region = regionsOf(component)[0];
    assert.ok(region.child instanceof CodexThinkingClickableComponent);
    assert.equal(region.handleMouse(event)?.handled, true, "the native region routes the gesture to the click layer");
  };
  update();
  assert.match(regionText(regionsOf(component)[0]), /reasoning row 11/);
  assert.doesNotMatch(regionText(regionsOf(component)[0]), /reasoning row 0\b/, "streaming starts in the real tail window");
  doubleClick();
  assert.notEqual(component.thinkingVisibilityOverrides.get(0), true, "a shown run needs no override entry");
  component.updateContent(message, true);
  assert.match(regionText(regionsOf(component)[0]), /reasoning row 0\b/, "double click reveals the full body");

  t.mock.timers.tick(2_920);
  update([...message.content, { type: "text", text: "out" }]);
  assert.equal(component.thinkingVisibilityOverrides.get(0), true, "completion folds the user's streaming choice once");
  assert.match(regionText(regionsOf(component)[0]), /Thought for 3s/);
  assert.doesNotMatch(regionText(regionsOf(component)[0]), /reasoning row/);
  t.mock.timers.tick(1_000);
  doubleClick();
  for (let i = 0; i < 3; i += 1) component.updateContent(message, true);
  assert.equal(component.thinkingVisibilityOverrides.get(0), false, "rebuilds preserve the post-completion choice");
  assert.match(regionText(regionsOf(component)[0]), /reasoning row 0\b[\s\S]*reasoning row 11/);
});

test("native history construction collapses without invented timing, and its click restores the body", (t) => {
  setup(t, new TranscriptState(() => 0), { streaming: "full", completed: "collapsed" }, {
    assistantPrototype: AssistantMessageComponent.prototype, makeRail: undefined,
  });
  // Use the actual constructor with a finalized message, without replaying transcript events.
  const component = new AssistantMessageComponent({ role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "EXPANDED_THINKING_SENTINEL restored reasoning" },
    { type: "text", text: "restored answer" },
  ] }, false, undefined, "Thinking...", 1, []);
  const region = regionsOf(component)[0];
  assert.ok(region, "history has a native thinking region");
  assert.equal(region.child.text, "Thought", "unknown duration is never fabricated as 0s");
  click(region);
  assert.match(regionsOf(component)[0].child.render(80).join(""), /EXPANDED_THINKING_SENTINEL/);
});
