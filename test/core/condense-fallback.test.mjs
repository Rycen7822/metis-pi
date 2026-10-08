import assert from "node:assert/strict";
import test from "node:test";
import { COOLDOWN_MS, FallbackController } from "../../src/condense/summarizer-fallback.ts";
import { splitPackingRuns } from "../../src/condense/packing.ts";

test("fallback announcements track real route changes and only one sibling claims a probe", () => {
  let now = 1000;
  const controller = new FallbackController(() => now);
  const primary = controller.chooseTarget("chain");
  assert.equal(primary.index, 0);
  assert.equal(controller.complete(primary, 1), "enter");
  const fallback = controller.chooseTarget("chain");
  assert.equal(fallback.index, 1);
  assert.equal(controller.complete(fallback, 1), "none");
  now += COOLDOWN_MS;
  const probe = controller.chooseTarget("chain");
  assert.equal(probe.index, 0);
  assert.equal(probe.wasProbe, true);
  assert.equal(controller.chooseTarget("chain").index, 1);
  assert.equal(controller.complete(probe, 0), "recover");
  assert.equal(controller.chooseTarget("chain").index, 0);
});

test("an older probe falling back cannot reverse a newer primary recovery", () => {
  let now = 1000;
  const controller = new FallbackController(() => now);
  controller.complete(controller.chooseTarget("chain"), 1);
  now += COOLDOWN_MS;
  const oldProbe = controller.chooseTarget("chain");
  const oldFallback = controller.chooseTarget("chain");
  now += COOLDOWN_MS;
  const newProbe = controller.chooseTarget("chain");
  assert.equal(controller.complete(newProbe, 0), "recover");
  assert.equal(controller.complete(oldProbe, 1), "none");
  assert.equal(controller.complete(oldFallback, 1), "none");
  assert.equal(controller.chooseTarget("chain").index, 0);
  assert.notEqual(controller.chooseTarget("chain").generation, oldProbe.generation);
});

test("an old failed probe cannot silently reroute a recovered primary", () => {
  let now = 1000;
  const controller = new FallbackController(() => now);
  controller.complete(controller.chooseTarget("chain"), 1);
  now += COOLDOWN_MS;
  const oldProbe = controller.chooseTarget("chain");
  now += COOLDOWN_MS;
  assert.equal(controller.complete(controller.chooseTarget("chain"), 0), "recover");
  assert.equal(controller.complete(oldProbe), "none");
  assert.equal(controller.chooseTarget("chain").index, 0);
});

test("switching target chains invalidates old decisions even after switching back", () => {
  const controller = new FallbackController(() => 1000);
  const old = controller.chooseTarget("a");
  controller.chooseTarget("b");
  const current = controller.chooseTarget("a");
  assert.notEqual(current.generation, old.generation);
  assert.equal(controller.complete(old, 1), "none");
  assert.equal(controller.chooseTarget("a").index, 0);
  assert.equal(controller.complete(current, 1), "enter");
});

test("steady fallback failures do not postpone an already due primary probe", () => {
  let now = 1000;
  const controller = new FallbackController(() => now);
  controller.complete(controller.chooseTarget("chain"), 1);
  const fallback = controller.chooseTarget("chain");
  now += COOLDOWN_MS;
  assert.equal(controller.complete(fallback), "none");
  assert.equal(controller.chooseTarget("chain").wasProbe, true);
});

test("packing-run plans are pure, idempotent and retain adjacent source ordering", () => {
  const build = Array.from({ length: 100 }, (_, i) => `building ${i} ` + "x".repeat(80)).join("\n");
  const call = (id, packable, isError = false) => ({
    toolCallId: id, toolName: "bash", args: { command: packable ? "npm run build" : "unknown-command" },
    resultText: packable ? build : "semantic evidence".repeat(400), isError, resultTimestamp: Number(id),
  });
  const calls = [call("1", true), call("2", true), call("3", false), call("4", true), call("5", true, true)];
  const batches = [{ turnIndex: 7, timestamp: 100, toolCalls: calls }];
  const before = structuredClone(batches);
  const plan = splitPackingRuns(batches);
  assert.deepEqual(plan.map(batch => batch.toolCalls.map(call => call.toolCallId)), [["1", "2"], ["3"], ["4"], ["5"]]);
  assert.deepEqual(plan.flatMap(batch => batch.toolCalls), calls);
  assert.deepEqual(splitPackingRuns(plan), plan);
  assert.deepEqual(batches, before);
  assert.ok(plan.every(batch => batch.turnIndex === 7 && batch.timestamp === 100));
  plan[0].toolCalls.pop();
  assert.equal(batches[0].toolCalls.length, 5, "planning must not share mutable source arrays");
});
