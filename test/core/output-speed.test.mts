import test from "node:test";
import assert from "node:assert/strict";
import { OutputSpeedTracker, computeSpeed, formatSpeed, formatSpeedValue } from "../../src/output-speed.ts";

test("a completed response pairs full usage with producer duration, never callback timing", () => {
  const tracker = new OutputSpeedTracker();
  assert.equal(tracker.snapshot(), undefined);
  tracker.requestStart();
  assert.equal(tracker.snapshot(), undefined, "no live estimate from incomplete usage");
  tracker.finish(1050, 10500, "stop");
  assert.deepEqual(tracker.snapshot(), { outputTokens: 1050, windowMs: 10500, tokensPerSecond: 100 });
  tracker.finish(9999, 1000, "stop");
  assert.equal(tracker.snapshot()!.tokensPerSecond, 100, "duplicate completion cannot replace a closed response");
  const previous = tracker.snapshot();
  tracker.requestStart();
  assert.equal(tracker.snapshot(), previous, "a pending response retains the latest completed average");
  tracker.finish(0, 10500, "stop");
  assert.equal(tracker.snapshot(), previous, "missing output does not erase the previous valid sample");
});

test("selection/context reset cancels a pending response and late completions cannot resurrect it", () => {
  const tracker = new OutputSpeedTracker();
  tracker.requestStart(); tracker.finish(40, 2000, "toolUse");
  tracker.reset();
  assert.equal(tracker.snapshot(), undefined);
  tracker.requestStart(); tracker.reset(); tracker.clearSample(); tracker.finish(40, 2000, "stop");
  assert.equal(tracker.snapshot(), undefined);
  tracker.requestStart(); tracker.finish(40, 2000, "length");
  assert.equal(tracker.snapshot()!.tokensPerSecond, 20, "a complete count for a length-limited response remains measurable");
});

for (const [tokens, duration, reason] of [
  [100, undefined, "stop"], [100, null, "stop"], [100, "1000", "stop"],
  [undefined, 1000, "stop"], ["100", 1000, "stop"], [100, 0, "stop"],
  [100, 1000, "error"], [100, 1000, "aborted"], [100, 1000, "deferred"],
  [100, 1000, "pending"], [100, 1000, undefined],
] as const) {
  test(`unconfirmed response preserves the last valid speed: ${tokens}/${duration}, ${reason}`, () => {
    const tracker = new OutputSpeedTracker();
    tracker.requestStart(); tracker.finish(50, 1000, "stop");
    const previous = tracker.snapshot();
    tracker.requestStart(); tracker.finish(tokens, duration, reason);
    assert.equal(tracker.snapshot(), previous, "incomplete or invalid measurements cannot replace the completed average");
    tracker.finish(100, 1000, "stop");
    assert.equal(tracker.snapshot(), previous, "an invalid terminal event still closes its response");
  });
}

for (const [tokens, ms, expected] of [
  [0, 10000, undefined], [-1, 1000, undefined], [1.5, 1000, undefined], [NaN, 1000, undefined],
  [Number.MAX_SAFE_INTEGER + 1, 1000, undefined], [10, NaN, undefined], [10, Infinity, undefined],
  [10, -1, undefined], [10, 0, undefined], [10, Number.MIN_VALUE, undefined],
  [1, 60000, 1 / 60], [2, 4000, 0.5],
  [3, 299, 3 / 0.299], [3, 300, 10], [3, 301, 3 / 0.301], [5001, 1000, 5001],
] as const) {
  test(`response-average arithmetic: ${tokens} tokens in ${ms}ms`, () => {
    assert.equal(computeSpeed(tokens, ms), expected);
  });
}

test("formatting identifies the response average and does not round a slow measured rate to zero", () => {
  assert.equal(formatSpeed(38.54), "avg 38.5 tok/s");
  assert.equal(formatSpeed(123.4), "avg 123 tok/s");
  assert.equal(formatSpeed(1 / 60), "avg 0.017 tok/s");
  assert.equal(formatSpeedValue(1e-9), "1e-9");
  for (const rate of [undefined, NaN, Infinity, -1, 0]) assert.equal(formatSpeed(rate), "");
});
