// interaction-outcome.test.mts — runtime verdict from terminal evidence only.
// Spec 11.4: drives the reducer through the same event shapes the extension
// handlers receive; text semantics ("完成"/"Failed") are never evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { InteractionOutcomeTracker } from "../../src/interaction-outcome.ts";

// Literal terminal verdicts; each row is one or two actual assistant attempts.
for (const [stops, outcome, evidence, toolErrors] of [
  [["stop"], "completed", "assistant-stop", 1],
  [["error"], "failed", "assistant-error", 0],
  [["length"], "incomplete", "assistant-length", 0],
  [["toolUse"], "unknown", "settled-only", 0],
  [["error", "stop"], "completed", "assistant-stop", 0],
  [["aborted", "stop"], "completed", "assistant-stop", 0],
  [["stop", "error"], "failed", "assistant-error", 0],
] as const) {
  test(`${stops.join(" → ")}: final assistant evidence decides ${outcome}`, () => {
    const tracker = new InteractionOutcomeTracker();
    for (const stop of stops) {
      tracker.messageStart("assistant");
      if (toolErrors) tracker.toolError();
      tracker.terminalStop(stop);
    }
    const verdict = tracker.freeze();
    assert.equal(verdict.outcome, outcome);
    assert.equal(verdict.evidence, evidence);
    assert.equal(verdict.attempt, stops.length);
    assert.equal(verdict.toolErrorsObserved, toolErrors, "tool errors are diagnostic counts");
  });
}

test("settled with no assistant evidence → unknown, never guessed success", () => {
  const t = new InteractionOutcomeTracker();
  assert.equal(t.freeze().outcome, "unknown");
  const t2 = new InteractionOutcomeTracker();
  t2.messageStart("user"); // user messages are not attempts
  assert.equal(t2.freeze().outcome, "unknown");
});
