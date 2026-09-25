// interaction-outcome.test.mts — runtime verdict from terminal evidence only.
// Spec 11.4: drives the reducer through the same event shapes the extension
// handlers receive; text semantics ("完成"/"Failed") are never evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { InteractionOutcomeTracker } from "../../src/interaction-outcome.ts";

/** One assistant attempt: message_start(role) → … → message_end(stopReason). */
function attempt(t: InteractionOutcomeTracker, stopReason: string, start = true) {
  if (start) t.messageStart("assistant");
  t.terminalStop(stopReason);
}

test("mid-run tool error then clean stop → completed, toolErrors counted", () => {
  const t = new InteractionOutcomeTracker();
  t.messageStart("assistant");
  t.toolError();
  t.terminalStop("stop");
  const v = t.freeze();
  assert.equal(v.outcome, "completed");
  assert.equal(v.toolErrorsObserved, 1);
  assert.equal(v.evidence, "assistant-stop");
});

test("assistant error → auto retry (new attempt) → clean stop → completed", () => {
  const t = new InteractionOutcomeTracker();
  attempt(t, "error");
  attempt(t, "stop");
  const v = t.freeze();
  assert.equal(v.outcome, "completed", "the LATER attempt's terminal wins");
  assert.equal(v.attempt, 2);
});

test("assistant error → settled, no retry → failed", () => {
  const t = new InteractionOutcomeTracker();
  attempt(t, "error");
  const v = t.freeze();
  assert.equal(v.outcome, "failed");
  assert.equal(v.evidence, "assistant-error");
});

test("aborted → host continues → clean stop → completed (no sticky interrupt)", () => {
  const t = new InteractionOutcomeTracker();
  attempt(t, "aborted");
  attempt(t, "stop");
  assert.equal(t.freeze().outcome, "completed");
});

test("length with no continuation → incomplete; toolUse alone at settle → unknown", () => {
  const length = new InteractionOutcomeTracker();
  attempt(length, "length");
  assert.equal(length.freeze().outcome, "incomplete");

  const toolUse = new InteractionOutcomeTracker();
  attempt(toolUse, "toolUse"); // non-terminal: the loop was expected to continue
  const v = toolUse.freeze();
  assert.equal(v.outcome, "unknown", "toolUse is not proof of a normal finish");
  assert.equal(v.evidence, "settled-only");
});

test("settled with no assistant evidence → unknown, never guessed success", () => {
  const t = new InteractionOutcomeTracker();
  assert.equal(t.freeze().outcome, "unknown");
  const t2 = new InteractionOutcomeTracker();
  t2.messageStart("user"); // user messages are not attempts
  assert.equal(t2.freeze().outcome, "unknown");
});

test("a later attempt's error replaces an earlier clean stop", () => {
  const t = new InteractionOutcomeTracker();
  t.messageStart("assistant");
  t.terminalStop("stop");   // attempt 1 finished clean
  t.messageStart("assistant"); // attempt 2 opens
  t.terminalStop("error");  // recorded for attempt 2 — attempt 2 now errored
  const v = t.freeze();
  // The terminal event has no attempt ID; it belongs to the current attempt.
  assert.equal(v.attempt, 2);
  assert.equal(v.outcome, "failed");
});
