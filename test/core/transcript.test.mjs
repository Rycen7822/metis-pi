// Transcript state and renderer projections need no native component/theme.
import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptState, renderedThinkingRuns, assistantHasVisibleThinking } from "../../src/transcript-state.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { createThinkingViewControl } from "../../src/thinking-view.ts";
import { theme, FakeText, sessionStub } from "../helpers.mjs";

const IMAGE_NAMES = ["first.png", "second.png", "third.png"];

test("message identity and thinking controls survive finalization, duplicate ends and late updates", () => {
  let now = 10;
  const state = new TranscriptState(() => now);
  const source = { role: "assistant", provider: "test", responseId: "r1", timestamp: 10, content: [{ type: "thinking", thinking: "working" }] };
  state.apply({ type: "message_start", message: source }, source);
  state.apply({ type: "message_update", message: source }, source);
  const key = state.identityOf(source);
  const control = createThinkingViewControl();
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
  assert.equal(state.identityOf(source), undefined);
  state.apply({ type: "message_start", message: source }, source);
  const nextKey = state.identityOf(source);
  assert.notEqual(nextKey, key, "an object reused after a session reset gets a fresh identity");
  assert.notEqual(
    state.thinkingViewControl(nextKey, 0, createThinkingViewControl),
    control,
    "a new session does not reuse a discarded thinking control",
  );
});

test("renderedThinkingRuns: semantic typing, empty runs, barriers and boundaries", () => {
  assert.equal(assistantHasVisibleThinking({ role: "assistant", content: [{ type: "text", text: "Thinking about it." }] }), false);
  assert.deepEqual(renderedThinkingRuns([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Thinking is ordinary text" },
    { type: "thinking", thinking: "" },
    { type: "thinking", thinking: "first" },
    { type: "toolCall", id: "t" },
    { type: "thinking", thinking: "second" },
    { type: "text", text: "" },
    { type: "thinking", thinking: "third" },
  ]), [
    { runIndex: 0, firstContentIndex: 2, endedInContent: true },
    { runIndex: 1, firstContentIndex: 5, endedInContent: true },
    { runIndex: 2, firstContentIndex: 7, endedInContent: false },
  ]);
});

test("identical response content keeps independent clocks and historical thinking choices", () => {
  let now = 0;
  const state = new TranscriptState(() => now);
  const first = { role: "assistant", timestamp: 1, content: [{ type: "thinking", thinking: "same" }] };
  const second = { ...first, timestamp: 2 };
  const observe = (message, duration) => {
    state.apply({ type: "message_start", message }, message);
    state.apply({ type: "message_update", message }, message);
    now += duration;
    state.apply({ type: "message_end", message }, message);
    return state.identityOf(message);
  };
  const a = observe(first, 10), b = observe(second, 100);
  for (const [message, key, duration] of [[first, a, 10], [second, b, 100]]) {
    const restored = state.registerFinalizedMessage(structuredClone(message), false);
    assert.equal(restored, key);
    assert.equal(state.thinkingRunPlan(restored, 0).thinkingMs, duration);
  }
  observe({ ...second }, 50); // timestamps can collide; clocks then stay unknown
  const ambiguous = state.registerFinalizedMessage(structuredClone(second), false);
  assert.equal(state.thinkingRunPlan(ambiguous, 0).thinkingMs, undefined);
  const cold = new TranscriptState();
  const coldA = cold.registerFinalizedMessage(first, false), coldB = cold.registerFinalizedMessage(second, false);
  assert.notEqual(coldA, coldB);
  assert.notEqual(cold.thinkingViewControl(coldA, 0, () => ({})), cold.thinkingViewControl(coldB, 0, () => ({})));
});

test("serial read appends update group membership and only the last image notice", () => {
  const transcript = new TranscriptState();
  const session = { ...sessionStub, transcript };
  const renderers = makeRenderers((s) => new FakeText(s), () => "ctrl+o to expand", undefined, undefined, undefined, undefined, session);
  const ids = [];
  for (let index = 0; index < IMAGE_NAMES.length; index++) {
    const id = `img${index}`;
    const message = { role: "assistant", content: [{ type: "toolCall", id }] };
    transcript.apply({ type: "message_start", message });
    transcript.apply({ type: "message_end", message });
    transcript.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read" });
    transcript.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError: false, imageCount: 1 });
    ids.push(id);
    assert.deepEqual(transcript.groupMemberIds(1), ids);
    assert.equal(transcript.explorationPlan(ids[0]).groupImages, ids.length, "older members see the new total");
    for (let member = 0; member < ids.length; member++) {
      const args = { path: `figures/${IMAGE_NAMES[member]}` };
      const call = renderers.read.renderCall(args, theme, { toolCallId: ids[member], isPartial: false, state: {}, args });
      const text = call.render(100).join("\n");
      if (member === index) assert.match(text, new RegExp(`\\b${ids.length} images?\\b`), "only the current tail reports the total");
      else assert.doesNotMatch(text, /\d+ images?\b/, "previous tails drop the aggregated notice");
      if (ids.length > 1) assert.doesNotMatch(text, /1 image\b/, "no per-member image notice");
    }
  }
});

test("read groups stop at tools, failures and visible thinking", () => {
  const state = new TranscriptState();
  const read = (id, isError = false) => {
    state.apply({ type: "tool_execution_start", toolCallId: id, toolName: "read" });
    state.apply({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError });
    return state.groupMemberIds(state.explorationPlan(id).groupId);
  };
  read("first");
  assert.deepEqual(read("second"), ["first", "second"]);
  for (const toolName of ["bash", "unrecognized_tool"]) {
    state.apply({ type: "tool_execution_start", toolCallId: toolName, toolName });
    assert.deepEqual(read(`after-${toolName}`), [`after-${toolName}`]);
  }
  assert.deepEqual(read("failed", true), ["after-unrecognized_tool", "failed"]);
  assert.deepEqual(read("after-failure"), ["after-failure"]);
  state.apply({ type: "message_update", message: {
    role: "assistant", content: [{ type: "thinking", thinking: "working" }],
  } });
  assert.deepEqual(read("after-thinking"), ["after-thinking"]);
});
