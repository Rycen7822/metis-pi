// output-speed.test.mts — the footer's tokens/s number.
// The scope rules ARE the feature: one window per assistant response, real
// confirmed output tokens, real observed window, nothing shown when the
// response is unmeasurable (no estimate, no 0.0 tok/s placeholder).
import test from "node:test";
import assert from "node:assert/strict";
import {
  OutputSpeedTracker,
  computeSpeed,
  formatSpeed,
  formatSpeedValue,
  SPEED_MAX_PLAUSIBLE,
  SPEED_MIN_WINDOW_MS,
} from "../src/output-speed.ts";

function makeTracker(start = 0) {
  let now = start;
  const tracker = new OutputSpeedTracker({ now: () => now });
  return { tracker, advance: (ms: number) => { now += ms; }, at: () => now };
}

test("finalized rate = confirmed output tokens ÷ first→last delta window", () => {
  const f = makeTracker();
  f.tracker.requestStart(); // request sent
  f.advance(900); // TTFT — excluded from the window
  f.tracker.delta();
  f.advance(2_100);
  f.tracker.delta();
  f.advance(100);
  f.tracker.finish(42);
  const sample = f.tracker.snapshot();
  assert.equal(sample?.scope, "final");
  assert.equal(sample?.outputTokens, 42);
  assert.equal(sample?.windowMs, 2_100);
  assert.equal(sample?.tokensPerSecond, 20);
});

test("request window is the fallback when deltas were batched (no delta span)", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(3_000);
  f.tracker.finish(30); // non-streaming: no delta events at all
  const sample = f.tracker.snapshot();
  assert.equal(sample?.windowMs, 3_000);
  assert.equal(sample?.tokensPerSecond, 10);
});

test("a delta window shorter than the minimum falls back to the request window", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(2_000);
  f.tracker.delta();
  f.advance(50); // below SPEED_MIN_WINDOW_MS — one burst, says nothing
  f.tracker.delta();
  f.tracker.finish(20);
  const sample = f.tracker.snapshot();
  assert.equal(sample?.windowMs, 2_050);
  assert.ok(sample!.windowMs >= SPEED_MIN_WINDOW_MS);
});

test("no confirmed output tokens → no sample (never a fabricated 0)", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(4_000);
  f.tracker.delta();
  f.advance(1_000);
  f.tracker.finish(0);
  assert.equal(f.tracker.snapshot(), undefined);
});

test("a message_end without usage keeps the previous response's number", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(1_000);
  f.tracker.delta();
  f.advance(1_000);
  f.tracker.finish(50);
  const first = f.tracker.snapshot();
  assert.equal(first?.outputTokens, 50);
  // Next response ends with no reported usage (abort/error path).
  f.tracker.requestStart();
  f.advance(5_000);
  f.tracker.delta();
  f.advance(500);
  f.tracker.finish(0);
  assert.equal(f.tracker.snapshot()?.outputTokens, 50, "last measured rate persists");
});

test("live rate uses streamed cumulative output and is replaced by the final one", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(400);
  f.tracker.delta();
  f.advance(1_000);
  assert.equal(f.tracker.preview(20), true, "cumulative count advanced");
  const live = f.tracker.snapshot();
  assert.equal(live?.scope, "live");
  assert.equal(live?.outputTokens, 20);
  assert.equal(live?.windowMs, 1_000);
  assert.equal(live?.tokensPerSecond, 20);
  // A repeated/older count must not re-open a frame.
  assert.equal(f.tracker.preview(20), false);
  assert.equal(f.tracker.preview(10), false, "counts never go backwards");
  f.advance(1_000);
  f.tracker.delta();
  f.tracker.finish(40);
  const final = f.tracker.snapshot();
  assert.equal(final?.scope, "final");
  assert.equal(final?.windowMs, 2_000, "delta span, not the live window at message_end");
  assert.equal(final?.tokensPerSecond, 20);
});

test("live rate stays hidden until the window is meaningful or tokens exist", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  assert.equal(f.tracker.preview(5), true, "window opened, but no delta yet");
  assert.equal(f.tracker.snapshot(), undefined, "no output start → no live rate");
  f.tracker.delta();
  f.advance(100); // below the minimum window
  assert.equal(f.tracker.snapshot(), undefined, "100ms window is not a rate");
  f.advance(400);
  assert.equal(f.tracker.snapshot()?.scope, "live");
});

test("events outside an open response window are ignored", () => {
  const f = makeTracker();
  assert.equal(f.tracker.preview(10), false);
  f.tracker.delta();
  f.tracker.finish(10);
  assert.equal(f.tracker.snapshot(), undefined, "no requestStart → nothing measured");
});

test("reset (session end) drops the sample; a new request clears only the live window", () => {
  const f = makeTracker();
  f.tracker.requestStart();
  f.advance(1_000);
  f.tracker.delta();
  f.advance(1_000);
  f.tracker.finish(24);
  assert.equal(f.tracker.snapshot()?.tokensPerSecond, 12);
  f.tracker.requestStart(); // next response: the last number stays visible
  assert.equal(f.tracker.snapshot()?.scope, "final");
  f.advance(1_000);
  f.tracker.delta();
  f.advance(1_000);
  f.tracker.preview(10);
  assert.equal(f.tracker.snapshot()?.scope, "live");
  f.tracker.reset();
  assert.equal(f.tracker.snapshot(), undefined, "session shutdown clears everything");
});

test("computeSpeed rails reject artifacts, not real rates", () => {
  assert.equal(computeSpeed(0, 10_000), undefined);
  assert.equal(computeSpeed(10, 200), undefined, "window below the minimum");
  assert.equal(computeSpeed(10, Number.NaN), undefined);
  assert.equal(computeSpeed(1, 60_000), undefined, "below one token per 10s is a stall, not a rate");
  assert.equal(computeSpeed(2, 4_000), 0.5, "slow but measurable still reports");
  assert.equal(computeSpeed(Number.MAX_SAFE_INTEGER, 1_000), undefined, "above the plausible rail");
  assert.ok(SPEED_MAX_PLAUSIBLE > 1000);
});

test("formatting keeps the unit with the value and omits unmeasurable numbers", () => {
  assert.equal(formatSpeed(38.456), "38.5 tok/s");
  assert.equal(formatSpeed(123.4), "123 tok/s");
  assert.equal(formatSpeed(9.95), "10 tok/s");
  assert.equal(formatSpeedValue(38.456), "38.5");
  assert.equal(formatSpeed(undefined), "");
  assert.equal(formatSpeed(0), "");
  assert.equal(formatSpeedValue(Number.NaN), "");
  assert.equal(formatSpeed(0.01), "", "never prints a rounded-to-zero rate");
});
