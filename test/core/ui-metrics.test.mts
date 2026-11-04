import test from "node:test";
import assert from "node:assert/strict";
import { UiMetrics, type InteractionSnapshot } from "../../src/appearance/activity/ui-metrics.ts";

test("writing and thinking share one retry clock; settlement resets the next interaction", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const ticks: InteractionSnapshot[] = [];
  const settled: InteractionSnapshot[] = [];
  const metrics = new UiMetrics(
    { now: () => now, wall: () => 1_000_000 + now },
    { onTick: (snapshot) => ticks.push(snapshot), onSettled: (snapshot) => settled.push(snapshot) },
  );
  t.after(() => metrics.reset());
  const advance = (ms: number) => { now += ms; };
  const timeouts = t.mock.method(globalThis, "setTimeout");
  const clears = t.mock.method(globalThis, "clearTimeout");
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
  metrics.recordUsage("req-1", { input: 100, output: 50 });
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
  assert.equal(clears.mock.calls.at(-1)?.arguments[0], timeouts.mock.calls.at(-1)?.result,
    "settlement cancels the remaining scheduled deadline");
  const stopped = ticks.length;
  t.mock.timers.tick(5_000);
  assert.equal(ticks.length, stopped, "settlement clears the actual timers and prevents later emissions");
});

test("ticks follow the visible run boundary without restarting on repeated thinking deltas", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000 });
  let origin: number | undefined;
  const ticks: InteractionSnapshot[] = [];
  const metrics = new UiMetrics(
    { now: () => Date.now(), wall: () => Date.now(), tickOrigin: () => origin },
    { onTick: snapshot => ticks.push(snapshot) },
  );
  t.after(() => metrics.reset());
  metrics.agentStart();
  metrics.thinkingStart(); // A provider can announce thinking before any visible reasoning exists.
  t.mock.timers.tick(375);
  origin = Date.now();
  metrics.thinkingStart();
  const before = ticks.length;
  t.mock.timers.tick(625);
  assert.equal(ticks.length, before, "the old interaction deadline must not sample before the run boundary");
  metrics.thinkingStart();
  metrics.thinkingStart();
  t.mock.timers.tick(375);
  assert.equal(ticks.length, before + 1, "deltas do not postpone the run deadline");
  assert.equal(ticks.at(-1)?.thinkingMs, 1_375, "activity includes the interval before visible reasoning");
  t.mock.timers.tick(1_000);
  assert.equal(ticks.at(-1)?.thinkingMs, 2_375);
});
