// ui-metrics.test.mts — the single interaction clock and phase machine.
// Focused on the semantics the prompt demands: agent_start opens the clock
// once, agent_end inside a chain does NOT reset it, agent_settled closes and
// finalizes, and phases derive ONLY from real content kinds (3.5).
import test from "node:test";
import assert from "node:assert/strict";
import { UiMetrics, formatDuration, formatTokensCompact } from "../src/ui-metrics.ts";
import type { UiMetricsCallbacks, ActivityPhase } from "../src/ui-metrics.ts";

interface Fixture {
  metrics: UiMetrics;
  ticks: Array<{ phase: ActivityPhase; elapsedMs: number }>;
  settled: Array<{ elapsedMs: number; thinkingMs: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
  advance: (ms: number) => void;
}

function makeMetrics(startWall = 1_000_000): Fixture {
  let now = 0;
  let wall = startWall;
  const ticks: Fixture["ticks"] = [];
  const settled: Fixture["settled"] = [];
  const metrics = new UiMetrics(
    { now: () => now, wall: () => wall },
    {
      onTick: (snapshot) => ticks.push({ phase: snapshot.phase, elapsedMs: snapshot.elapsedMs }),
      onSettled: (snapshot) => settled.push({
        elapsedMs: snapshot.elapsedMs,
        thinkingMs: snapshot.thinkingMs,
        usage: snapshot.usage, // full UsageTotals
      }),
    },
  );
  return {
    metrics,
    ticks,
    settled,
    advance(ms) {
      now += ms;
      wall += ms;
    },
  };
}

test("one clock per interaction: retries and compaction gaps do not reset elapsed", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.advance(4_000);
  f.metrics.agentEnd(); // retry boundary
  f.advance(1_500); // gap (compaction / queued retry)
  f.metrics.agentStart(); // must NOT reset the open clock
  f.advance(2_500);
  f.metrics.agentSettled();
  assert.equal(f.settled.length, 1);
  assert.equal(f.settled[0]!.elapsedMs, 8_000);
});

test("fresh user prompt after settle opens a NEW clock", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.advance(3_000);
  f.metrics.agentSettled();
  f.metrics.agentStart();
  f.advance(1_000);
  f.metrics.agentSettled();
  assert.deepEqual(f.settled.map((s) => s.elapsedMs), [3_000, 1_000]);
});

test("thinking phase measured from real thinking content, closed on transition", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.advance(500);
  f.metrics.thinkingStart(); // first real thinking block streamed
  f.advance(6_000);
  f.metrics.thinkingEnd(); // text/toolCall transition closes the interval
  f.metrics.setPhase("working");
  f.advance(4_000);
  f.metrics.agentSettled();
  assert.equal(f.settled[0]!.thinkingMs, 6_000);
  assert.equal(f.settled[0]!.elapsedMs, 10_500);
});

test("thinking pauses are EXCLUDED: only streamed intervals count", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.metrics.thinkingStart();
  f.advance(2_000);
  f.metrics.thinkingEnd(); // provider pause / tool loop
  f.advance(9_000);
  f.metrics.thinkingStart();
  f.advance(1_000);
  f.metrics.thinkingEnd();
  f.metrics.agentSettled();
  assert.equal(f.settled[0]!.thinkingMs, 3_000);
});

test("write streaming phase feeds the Working line without touching thinking totals", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.metrics.writeStreaming();
  f.advance(2_000);
  f.metrics.tickNow(); // manual tick: phase visible in the Working line
  const writingTick = f.ticks.at(-1);
  f.metrics.toolStart(); // write executes
  f.advance(1_000);
  f.metrics.agentSettled();
  assert.equal(writingTick?.phase, "writing");
  assert.equal(f.settled[0]!.thinkingMs, 0);
});

test("ticker emits seconds and stops after settle", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.advance(1_000);
  f.metrics.tickNow(); // tick 1
  f.advance(1_000);
  f.metrics.tickNow(); // tick 2
  f.advance(400);
  f.metrics.tickNow(); // same second → still emits (manual hook), fine
  assert.equal(f.ticks.length, 4); // +1 initial emit from agentStart
  f.metrics.agentSettled();
  const before = f.ticks.length;
  assert.equal(f.metrics.tickerAlive, false);
  f.advance(5_000);
  f.metrics.tickNow();
  assert.equal(f.ticks.length, before); // no emission after settle
});

test("reset drops everything (session_shutdown)", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.advance(2_000);
  f.metrics.reset();
  f.metrics.agentSettled(); // no open clock → no onSettled
  assert.equal(f.settled.length, 0);
  f.metrics.agentStart();
  f.advance(700);
  f.metrics.agentSettled();
  assert.equal(f.settled[0]!.elapsedMs, 700);
});

test("usage totals dedupe by request key and survive replays", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.metrics.recordUsage("req-1", { input: 100, output: 50 });
  f.metrics.recordUsage("req-1", { input: 100, output: 50 }); // replay
  f.metrics.recordUsage("req-2", { input: 30, output: 10 });
  f.metrics.agentSettled();
  assert.deepEqual(f.settled[0]!.usage, { input: 130, output: 60, cacheRead: 0, cacheWrite: 0 });
});

test("toolStart while waiting-for-input does not steal the phase", () => {
  const f = makeMetrics();
  f.metrics.agentStart();
  f.metrics.uiPromptStart(); // permission dialog
  f.metrics.toolStart();
  f.advance(100);
  f.metrics.tickNow();
  assert.equal(f.ticks.at(-1)?.phase, "waiting-for-input");
});

test("formatDuration is Codex-style compact", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(61_000), "1m 01s"); // leading zero in compound form (Codex reference)
  assert.equal(formatDuration(3_600_000), "1h 00m 00s");
  assert.equal(formatTokensCompact(1_000), "1k");
  assert.equal(formatTokensCompact(1_234_567), "1235k"); // implementation keeps k below 10M
});
test("write arg streaming closes stale thinking (0.8.1): accumulated thinking must not keep Thinking lit", () => {
  const fx = makeMetrics();
  fx.metrics.agentStart();
  // Old thinking block streamed and closed.
  fx.metrics.thinkingStart();
  fx.advance(2_000);
  fx.metrics.thinkingEnd();
  // Now the model streams a write tool call's arguments - the accumulated
  // message still contains the old thinking block, but the CURRENT event is
  // a toolcall delta for `write`. The production extension feed calls, in
  // order: thinkingEnd (stale phase off) + writeStreaming.
  fx.metrics.thinkingEnd();   // idempotent for already-closed run
  fx.metrics.writeStreaming();
  fx.advance(1_000);
  const snap = fx.metrics.snapshot();
  assert.equal(snap.phase, "writing");
  assert.equal(snap.thinkingMs, 2_000, "thinking timer closed at thinking_end, not extended");
  // A later text delta must fall back to plain working, never back to thinking.
  fx.metrics.setPhase("working");
  fx.advance(500);
  assert.equal(fx.metrics.snapshot().phase, "working");
  // writeStreaming keeps the writing phase while more args stream.
  fx.metrics.writeStreaming();
  fx.advance(500);
  assert.equal(fx.metrics.snapshot().phase, "writing");
  fx.metrics.agentSettled();
});
