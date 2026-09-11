// working.test.mts — the above-editor Working line: segment order, config
// gating, width guard. Spec 7 + 11.3 (dual timers).
import test from "node:test";
import assert from "node:assert/strict";
import { formatWorkingLine, createWorkingComponent, WORKING_WIDGET_KEY } from "../src/chrome/working.ts";

const SHOW = { elapsed: true, thought: true, tool: true, tokens: true };

test("segment order: Message · Tool · Elapsed · Thought · Tokens", () => {
  const line = formatWorkingLine({
    active: true,
    phase: "working",
    elapsedMs: 188_000, // 3m 08s
    thinkingMs: 19_000,
    thinkingOpen: true,
    usage: { input: 131_000, output: 5000 },
    tools: { first: "bash", count: 1 },
  }, SHOW);
  assert.equal(line, "Working… · bash · 3m 08s · thinking 19s · ↑131k ↓5.0k");
});

test("closed thinking renders 'thought for'; writing phase renders Writing…", () => {
  const line = formatWorkingLine({
    active: true,
    phase: "writing",
    elapsedMs: 215_000, // 3m 35s
    thinkingMs: 19_000,
    thinkingOpen: false,
    usage: { input: 131_000, output: 5000 },
    tools: { first: "write", count: 1 },
  }, SHOW);
  assert.equal(line, "Writing… · write · 3m 35s · thought for 19s · ↑131k ↓5.0k");
});

test("parallel tools render as 'name +N'; no tools omit the segment", () => {
  const parallel = formatWorkingLine({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false,
    usage: { input: 0, output: 0 }, tools: { first: "bash", count: 3 },
  }, SHOW);
  assert.ok(parallel.includes("bash +2"));
  const none = formatWorkingLine({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false,
    usage: { input: 0, output: 0 }, tools: undefined,
  }, SHOW);
  assert.doesNotMatch(none, /bash|read|write/);
});

test("waiting-for-input label; zero usage omits tokens; zero thinking omits thought", () => {
  const line = formatWorkingLine({
    active: true, phase: "waiting-for-input", elapsedMs: 5000, thinkingMs: 0, thinkingOpen: false,
    usage: { input: 0, output: 0 }, tools: undefined,
  }, SHOW);
  assert.equal(line, "Waiting for input · 5s");
});

test("elapsed:false removes ONLY the duration — thought/tool/tokens stay", () => {
  const line = formatWorkingLine({
    active: true, phase: "working", elapsedMs: 188_000, thinkingMs: 19_000, thinkingOpen: true,
    usage: { input: 131_000, output: 5000 }, tools: { first: "bash", count: 1 },
  }, { elapsed: false, thought: true, tool: true, tokens: true });
  assert.equal(line, "Working… · bash · thinking 19s · ↑131k ↓5.0k");
  assert.doesNotMatch(line, /3m 08s/);
});

test("component: inactive renders nothing; width guard never overflows", () => {
  const component = createWorkingComponent({
    getSnapshot: () => ({
      active: true, phase: "working", elapsedMs: 3_600_000, thinkingMs: 0, thinkingOpen: false,
      usage: { input: 0, output: 0 }, tools: undefined,
    }),
    getShow: () => SHOW,
  });
  assert.equal(component.render(0).length, 0);
  assert.equal(component.render(1).length, 1);
  for (const w of [5, 10, 40, 120]) {
    const rows = component.render(w);
    for (const row of rows) {
      assert.ok(row.replace(/\x1b\[[0-9;]*m/g, "").length <= w, `width ${w} not exceeded`);
    }
  }
  const idle = createWorkingComponent({
    getSnapshot: () => ({
      active: false, phase: "idle", elapsedMs: 0, thinkingMs: 0, thinkingOpen: false,
      usage: { input: 0, output: 0 }, tools: undefined,
    }),
    getShow: () => SHOW,
  });
  assert.deepEqual(idle.render(80), []);
});

test("widget key is namespaced to this extension", () => {
  assert.equal(WORKING_WIDGET_KEY, "pi-codex-appearance:working");
});
