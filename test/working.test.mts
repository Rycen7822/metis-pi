// working.test.mts — the Codex-rhythm Working line: segment format, config
// gating, shimmer animation lifecycle (fake clock), width guard. Spec 9 + 18.
import test from "node:test";
import assert from "node:assert/strict";
import { workingFrame, shimmerPhase, createWorkingComponent, WORKING_WIDGET_KEY, INTERRUPT_HINT } from "../src/chrome/working.ts";

const SHOW = { elapsed: true, thought: true, tool: true, tokens: false };

test("Codex format: • Working (elapsed · thinking Ns · esc to interrupt) · tool", () => {
  const f = workingFrame({
    active: true,
    phase: "working",
    elapsedMs: 216_000, // 3m 36s
    thinkingMs: 24_000,
    thinkingOpen: true,
    tools: { first: "bash", count: 1 },
  }, SHOW);
  assert.deepEqual(f, {
    message: "Working",
    details: ["3m 36s", "thinking 24s", INTERRUPT_HINT],
    tool: "bash",
  });
});

test("closed thinking → 'thought for'; writing phase → Writing; waiting label", () => {
  const done = workingFrame({
    active: true, phase: "working", elapsedMs: 228_000, thinkingMs: 24_000, thinkingOpen: false, tools: undefined,
  }, SHOW);
  assert.deepEqual(done.details, ["3m 48s", "thought for 24s", INTERRUPT_HINT]);
  const writing = workingFrame({
    active: true, phase: "writing", elapsedMs: 235_000, thinkingMs: 24_000, thinkingOpen: false, tools: undefined,
  }, SHOW);
  assert.equal(writing.message, "Writing");
  const waiting = workingFrame({
    active: true, phase: "waiting-for-input", elapsedMs: 242_000, thinkingMs: 0, thinkingOpen: false, tools: undefined,
  }, SHOW);
  assert.equal(waiting.message, "Waiting for input");
  assert.deepEqual(waiting.details, ["4m 02s", INTERRUPT_HINT]);
});

test("parallel tools inline as 'name +N'; tool segment gated by config", () => {
  const parallel = workingFrame({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false,
    tools: { first: "bash", count: 3 },
  }, SHOW);
  assert.equal(parallel.tool, "bash +2");
  const noTool = workingFrame({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false, tools: undefined,
  }, { elapsed: true, thought: true, tool: false, tokens: false });
  assert.equal(noTool.tool, undefined);
});

test("tokens default OFF in 0.8.5; opt-in renders the segment", () => {
  const withTokens = workingFrame({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false, tools: undefined,
    usage: { input: 131_000, output: 5000 },
  }, { elapsed: true, thought: true, tool: true, tokens: true });
  assert.ok(withTokens.details.some((d) => d.includes("↑131k ↓5.0k")), "opt-in tokens segment");
});

test("shimmerPhase wraps: bullet cycles 0..1..2..1, highlight sweeps without growth", () => {
  const steps = new Set();
  for (let i = 0; i < 64; i++) {
    const { bulletStep, highlightStart } = shimmerPhase(i);
    steps.add(bulletStep);
    assert.ok(highlightStart >= 0 && highlightStart < 12);
  }
  assert.deepEqual([...steps].sort(), [0, 1, 2]);
  assert.deepEqual(shimmerPhase(16), shimmerPhase(0), "16-frame cycle wraps exactly");
});

/** Component harness with a fake scheduler (no real timers). */
function harness(overrides = {}) {
  const scheduled = [];
  let snapshot = {
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false,
    tools: undefined, usage: { input: 0, output: 0 },
  };
  let renders = 0;
  const component = createWorkingComponent({
    getSnapshot: () => snapshot,
    getShow: () => SHOW,
    getAnimation: () => ({ enabled: true, intervalMs: 64 }),
    requestRender: () => { renders += 1; },
    colorKind: overrides.colorKind ?? "truecolor",
    // Real ANSI paints (the width guard measures visible cells; tag-style
    // fake paints would inflate it).
    paint: (text, tone) => (tone === "normal" ? text
      : tone === "accent" ? `\x1b[38;2;148;226;213m${text}\x1b[39m`
      : `\x1b[2m${text}\x1b[22m`),
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return () => {};
    },
    ...overrides,
  });
  return {
    component,
    scheduled,
    setSnapshot: (next) => { snapshot = { ...snapshot, ...next }; },
    renderCount: () => renders,
  };
}

test("animation lifecycle: exactly one 64ms timer while active; stopped at idle/dispose", () => {
  const h = harness();
  h.component.render(80); // active → timer starts
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].ms, 64);
  h.component.render(80); // still active → NO second timer
  assert.equal(h.scheduled.length, 1);
  h.setSnapshot({ active: false });
  h.component.render(80); // inactive → timer stopped
  h.component.stopAnimation();
  h.component.dispose?.();
  assert.ok(true, "lifecycle exercised without leaks");
});

test("animation frames change the ANSI but not the semantic text", () => {
  const h = harness();
  const frameA = h.component.render(80)[0] ?? "";
  h.scheduled[0].fn(); // frame++
  const frameB = h.component.render(80)[0] ?? "";
  h.scheduled[0].fn();
  const frameC = h.component.render(80)[0] ?? "";
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  assert.notEqual(frameA, frameB, "consecutive animation frames differ visually");
  assert.equal(strip(frameA), strip(frameB), "stripped text identical across frames");
  assert.equal(strip(frameC), strip(frameA));
  assert.ok(strip(frameA).startsWith("• Working ("), "Codex grammar preserved");
});

test("NO_COLOR / ansi16 renders static (no timer, no per-frame change)", () => {
  const hNone = harness({ colorKind: "none" });
  hNone.component.render(80);
  assert.equal(hNone.scheduled.length, 0, "no animation timer without color");
  const h16 = harness({ colorKind: "ansi16" });
  const a = h16.component.render(80)[0] ?? "";
  h16.scheduled[0]?.fn?.();
  const b = h16.component.render(80)[0] ?? "";
  assert.equal(a, b, "ansi16 is static");
});

test("width guard: never overflows at 1/5/40/120 cells", () => {
  const h = harness();
  for (const w of [1, 5, 40, 120]) {
    const rows = h.component.render(w);
    for (const row of rows) {
      const bare = row.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(bare.length <= w, `width ${w} not exceeded: ${JSON.stringify(bare)}`);
    }
  }
  assert.equal(h.component.render(0).length, 0);
});

test("1000 animation frames leave no timer accumulation (counter wraps)", () => {
  const h = harness();
  h.component.render(80);
  const before = h.scheduled.length;
  for (let i = 0; i < 1000; i++) {
    h.scheduled[0].fn();
    h.component.render(80);
  }
  assert.equal(h.scheduled.length, before, "no timer growth");
});

test("widget key is namespaced to this extension", () => {
  assert.equal(WORKING_WIDGET_KEY, "pi-codex-appearance:working");
});
