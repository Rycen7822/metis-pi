// working.test.mts — the Codex-rhythm Working line: segment format, config
// gating, shimmer animation lifecycle (fake clock), width guard. Spec 9 + 18.
import test from "node:test";
import assert from "node:assert/strict";
import { workingFrame, shimmerPhase, shimmerCellColor, createWorkingComponent, INTERRUPT_HINT, type WorkingComponentInput, type WorkingSnapshotWithUsage } from "../../src/chrome/working.ts";

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

test("tokens default OFF in 0.8.5; opt-in renders the segment", () => {
  const withTokens = workingFrame({
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false, tools: undefined,
    usage: { input: 131_000, output: 5000 },
  }, { elapsed: true, thought: true, tool: true, tokens: true });
  assert.ok(withTokens.details.some((d) => d.includes("↑131k ↓5.0k")), "opt-in tokens segment");
});

test("shimmer cycle: one wave fully exits before the next enters (no overlap)", () => {
  const word = "Working".length; // 7
  const trail = 5;
  const cycle = Math.ceil((word + trail + 1) / 0.25) + 16;
  const litAt = (f: number): number[] => {
    const { head } = shimmerPhase(f, word);
    const out: number[] = [];
    for (let i = 0; i < word; i++) {
      const dist = head - i;
      if (dist >= 0 && dist < trail) out.push(i);
    }
    return out;
  };
  // The head advances monotonically WITHIN a wave (the cycle wrap restarts
  // at the left edge by design).
  for (let f = 1; f < cycle * 2 + 7; f++) {
    if (f % cycle === 0) continue;
    assert.ok(shimmerPhase(f, word).head >= shimmerPhase(f - 1, word).head, `frame ${f}: head moved backwards mid-wave`);
  }
  // A wave fully exits before the next enters: once the word goes dark, it
  // only lights up again exactly at the cycle boundary.
  let exited = false;
  for (let f = 1; f < cycle * 2 + 7; f++) {
    const prev = litAt(f - 1);
    const cur = litAt(f);
    if (prev.length > 0 && cur.length === 0) exited = true;
    if (f % cycle === 0) exited = false; // cycle boundary = legitimate re-entry
    if (exited && cur.length > 0) {
      assert.ok(f % cycle === 0, `frame ${f}: a new wave started before the previous one finished`);
      exited = false;
    }
  }
  // Cycle wraps exactly.
  assert.deepEqual(shimmerPhase(cycle, word), shimmerPhase(0, word));
  // LEISURELY pace: the head advances 0.25 cells per frame (4 frames per
  // cell) — the high frame rate drives intensity flow, not sweep speed.
  assert.equal(shimmerPhase(4, word).head - shimmerPhase(0, word).head, 1);
  // Consecutive frames still differ in intensity (smooth sub-cell flow):
  // the cell just behind the head changes shade within 2 frames.
  const { head: h0 } = shimmerPhase(8, word);
  const c0 = shimmerCellColor(h0 - Math.floor(h0));
  const { head: h1 } = shimmerPhase(9, word);
  const c1 = shimmerCellColor(h1 - Math.floor(h1));
  assert.notDeepEqual(c0, c1, "trail intensity flows frame-to-frame");
  // Bullet steps cycle on their own 2-frame cadence.
  const steps = new Set();
  for (let i = 0; i < 64; i++) steps.add(shimmerPhase(i, word).bulletStep);
  assert.deepEqual([...steps].sort(), [0, 1, 2]);
  assert.equal(shimmerPhase(0, word).bulletStep, shimmerPhase(1, word).bulletStep, "bullet holds across frames");
});

test("shimmer gradient: head brighter than trail end, unlit outside the trail", () => {
  assert.ok(shimmerCellColor(0)![0] > shimmerCellColor(4.75)![0], "head brighter than trail end");
  assert.equal(shimmerCellColor(5), undefined, "beyond the trail → unlit");
  assert.equal(shimmerCellColor(-0.1), undefined, "ahead of the head → unlit");
});

/** Component harness with a fake scheduler (no real timers). */
function harness(overrides: Partial<WorkingComponentInput> = {}) {
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  let snapshot: WorkingSnapshotWithUsage = {
    active: true, phase: "working", elapsedMs: 1000, thinkingMs: 0, thinkingOpen: false,
    tools: undefined, usage: { input: 0, output: 0 },
  };
  const component = createWorkingComponent({
    getSnapshot: () => snapshot,
    getShow: () => SHOW,
    getAnimation: () => ({ enabled: true, intervalMs: 64 }),
    requestRender: () => {},
    colorKind: overrides.colorKind ?? "truecolor",
    // Real ANSI paints (the width guard measures visible cells; tag-style
    // fake paints would inflate it).
    paint: (text, tone) => (tone === "normal" ? text
      : tone === "accent" ? `\x1b[38;2;137;180;250m${text}\x1b[39m`
      : `\x1b[2m${text}\x1b[22m`),
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      scheduled.push(timer);
      return () => { timer.cancelled = true; };
    },
    ...overrides,
  });
  return {
    component,
    scheduled,
    setSnapshot: (next: Partial<WorkingSnapshotWithUsage>) => { snapshot = { ...snapshot, ...next }; },
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
  assert.equal(h.scheduled[0].cancelled, true, "idle cancels the only timer");
  h.component.stopAnimation();
  h.component.dispose?.();
  assert.equal(h.scheduled.length, 1, "cleanup does not schedule again");
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
