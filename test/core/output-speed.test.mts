// output-speed.test.mts — the footer's tokens/s number.
// The scope rules ARE the feature: one window per assistant response, real
// confirmed output tokens, real observed window, nothing shown when the
// response is unmeasurable (no estimate, no 0.0 tok/s placeholder).
import test from "node:test";
import assert from "node:assert/strict";
import {
  OutputSpeedTracker,
  computeSpeed,
} from "../../src/output-speed.ts";

// Times are absolute milliseconds since requestStart; expected windows are independent literals.
for (const scenario of [
  { name: "delta window excludes TTFT and the trailing finish delay", deltaAt: [900, 3_000], finishAt: 3_100, tokens: 42,
    expected: { scope: "final", outputTokens: 42, windowMs: 2_100, tokensPerSecond: 20 } },
  { name: "no deltas falls back to the request window", deltaAt: [], finishAt: 3_000, tokens: 30,
    expected: { scope: "final", outputTokens: 30, windowMs: 3_000, tokensPerSecond: 10 } },
  { name: "a 50ms burst falls back to the request window", deltaAt: [2_000, 2_050], finishAt: 2_050, tokens: 20,
    expected: { scope: "final", outputTokens: 20, windowMs: 2_050, tokensPerSecond: 20 / 2.05 } },
  { name: "no confirmed output never fabricates a zero sample", deltaAt: [4_000], finishAt: 5_000, tokens: 0,
    expected: undefined },
]) {
  test(scenario.name, () => {
    let now = 0;
    const tracker = new OutputSpeedTracker({ now: () => now });
    tracker.requestStart();
    for (const at of scenario.deltaAt) {
      now = at;
      tracker.delta();
    }
    now = scenario.finishAt;
    tracker.finish(scenario.tokens);
    assert.deepEqual(tracker.snapshot(), scenario.expected);
  });
}

test("live rate finalizes once and remains visible across a later response without usage", () => {
  let now = 0;
  const tracker = new OutputSpeedTracker({ now: () => now });
  tracker.requestStart();
  now = 400;
  tracker.delta();
  now = 1_400;
  assert.equal(tracker.preview(20), true, "cumulative count advanced");
  assert.deepEqual(tracker.snapshot(), { scope: "live", outputTokens: 20, windowMs: 1_000, tokensPerSecond: 20 });
  // A repeated/older count must not re-open a frame.
  assert.equal(tracker.preview(20), false);
  assert.equal(tracker.preview(10), false, "counts never go backwards");
  now = 2_400;
  tracker.delta();
  tracker.finish(40);
  const final = tracker.snapshot();
  assert.deepEqual(final, { scope: "final", outputTokens: 40, windowMs: 2_000, tokensPerSecond: 20 });
  tracker.requestStart();
  now = 7_400;
  tracker.delta();
  now = 7_900;
  tracker.finish(0);
  assert.deepEqual(tracker.snapshot(), final, "missing usage preserves the entire last measured sample");
});

// Independent bounds include zero output, invalid clocks, stalled output and exact rails.
for (const [tokens, ms, expected] of [
  [0, 10_000, undefined], [10, Number.NaN, undefined],
  [1, 60_000, undefined], [2, 4_000, 0.5], [Number.MAX_SAFE_INTEGER, 1_000, undefined],
  [3, 299, undefined], [3, 300, 10], [3, 301, 3 / 0.301],
  [4_999, 1_000, 4_999], [5_000, 1_000, 5_000], [5_001, 1_000, undefined],
] as const) {
  test(`computeSpeed boundary: ${tokens} tokens in ${ms}ms`, () => {
    assert.equal(computeSpeed(tokens, ms), expected);
  });
}
