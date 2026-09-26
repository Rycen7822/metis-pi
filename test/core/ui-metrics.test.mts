// ui-metrics.test.mts — the single interaction clock and phase machine.
// Focused on the semantics the prompt demands: agent_start opens the clock
// once, agent_end inside a chain does NOT reset it, agent_settled closes and
// finalizes, and phases derive ONLY from real content kinds (3.5).
import test from "node:test";
import assert from "node:assert/strict";
import { UiMetrics, type InteractionSnapshot } from "../../src/ui-metrics.ts";

test("writing and thinking share one retry clock; settlement resets the next interaction", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  const ticks: InteractionSnapshot[] = [];
  const settled: InteractionSnapshot[] = [];
  const metrics = new UiMetrics(
    { now: () => now, wall: () => 1_000_000 + now },
    { onTick: (snapshot) => ticks.push(snapshot), onSettled: (snapshot) => settled.push(snapshot) },
  );
  t.after(() => metrics.reset());
  const advance = (ms: number) => { now += ms; };
  const intervals = t.mock.method(globalThis, "setInterval");
  const clears = t.mock.method(globalThis, "clearInterval");
  metrics.agentStart();
  metrics.recordUsage("req-1", { input: 100, output: 50 });
  metrics.writeStreaming();
  advance(500);
  assert.equal(metrics.snapshot().phase, "writing");
  assert.equal(metrics.snapshot().thinkingMs, 0, "writing cannot invent a thinking interval");
  metrics.thinkingStart();
  advance(4_000);
  metrics.thinkingEnd();
  metrics.thinkingEnd(); // repeated close cannot resurrect the interval
  metrics.writeStreaming();
  advance(500);
  assert.equal(metrics.snapshot().phase, "writing");
  metrics.setPhase("working");
  assert.equal(metrics.snapshot().phase, "working");
  assert.equal(metrics.snapshot().thinkingMs, 4_000, "a thinking pause is excluded before any run-end event");
  metrics.agentEnd(); // a retry/compaction boundary, not interaction completion
  advance(1_000);
  metrics.agentStart();
  metrics.recordUsage("req-1", { input: 100, output: 50 }); // replay across the retry
  metrics.thinkingStart();
  advance(2_000);
  metrics.thinkingEnd();
  assert.equal(metrics.snapshot().elapsedMs, 8_000, "retry keeps the original clock, including its gap");
  assert.equal(metrics.snapshot().thinkingMs, 6_000, "only the two streamed intervals count");
  metrics.writeStreaming();
  advance(500);
  assert.equal(metrics.snapshot().phase, "writing");
  metrics.toolStart();
  metrics.recordUsage("req-2", { input: 30, output: 10 });
  advance(2_000);
  metrics.agentSettled();
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.elapsedMs, 10_500);
  assert.equal(settled[0]!.thinkingMs, 6_000, "working after thinking does not extend the interval");
  assert.deepEqual(settled[0]!.usage, { input: 130, output: 60, cacheRead: 0, cacheWrite: 0 });

  metrics.agentStart();
  metrics.writeStreaming();
  const beforeTick = ticks.length;
  advance(1_000);
  t.mock.timers.tick(1_000);
  assert.equal(ticks.length, beforeTick + 1, "one scheduled callback owns the new interaction");
  assert.equal(ticks.at(-1)?.elapsedMs, 1_000);
  metrics.agentSettled();
  assert.deepEqual(settled.map((snapshot) => snapshot.elapsedMs), [10_500, 1_000]);
  assert.equal(settled[1]!.thinkingMs, 0, "closed thinking belongs only to the previous interaction");
  assert.deepEqual(settled[1]!.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(clears.mock.calls.map((call) => call.arguments[0]), intervals.mock.calls.map((call) => call.result));
  const stopped = ticks.length;
  t.mock.timers.tick(5_000);
  assert.equal(ticks.length, stopped, "settlement clears the actual timers and prevents later emissions");
});
