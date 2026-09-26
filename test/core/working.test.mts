import test from "node:test";
import assert from "node:assert/strict";
import { workingFrame, createWorkingComponent, type WorkingSnapshotWithUsage } from "../../src/chrome/working.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const SHOW = { elapsed: true, thought: true, tool: true, tokens: false };
const snapshot: WorkingSnapshotWithUsage = {
  active: true, phase: "working", elapsedMs: 216_000, thinkingMs: 24_000, thinkingOpen: true,
  tools: { first: "bash", count: 1 }, usage: { input: 131_000, output: 5000 },
};

test("working phases and token opt-in have literal presentation contracts", () => {
  for (const [phase, thinkingOpen, thinkingMs, message, thought] of [
    ["working", true, 24_000, "Working", "thinking 24s"],
    ["working", false, 24_000, "Working", "thought for 24s"],
    ["writing", false, 24_000, "Writing", "thought for 24s"],
    ["waiting-for-input", false, 0, "Waiting for input", undefined],
  ] as const) {
    assert.deepEqual(workingFrame({ ...snapshot, phase, thinkingOpen, thinkingMs }, SHOW), {
      message, details: ["3m 36s", ...(thought ? [thought] : []), "esc to interrupt"], tool: "bash",
    });
  }
  assert.deepEqual(workingFrame(snapshot, { ...SHOW, tokens: true }).details,
    ["3m 36s", "thinking 24s", "↑131k ↓5.0k", "esc to interrupt"]);
});

test("real animation scheduler handles one timer, static colors, idle and disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const repaint = t.mock.fn();
  for (const colorKind of ["truecolor", "ansi16", "none"] as const) {
    let active = true;
    const component = createWorkingComponent({
      getSnapshot: () => ({ ...snapshot, active }), getShow: () => SHOW,
      getAnimation: () => ({ enabled: true, intervalMs: 64 }), colorKind,
      requestRender: repaint,
      paint: (text, tone) => tone === "normal" ? text : tone === "accent"
        ? `\x1b[36m${text}\x1b[39m` : `\x1b[2m${text}\x1b[22m`,
    });
    t.after(() => component.dispose?.());
    const first = component.render(120);
    component.render(120);
    repaint.mock.resetCalls();
    t.mock.timers.tick(64);
    assert.equal(repaint.mock.callCount(), colorKind === "truecolor" ? 1 : 0, "repeat renders cannot add timers");
    t.mock.timers.tick(512);
    if (colorKind === "truecolor") assert.notDeepEqual(component.render(120), first);
    else assert.deepEqual(component.render(120), first, "limited colors stay static");
    for (const width of [1, 5, 40, 120]) {
      assert.ok(component.render(width).every((row) => visibleWidth(row) <= width));
    }
    assert.deepEqual(component.render(0), []);
    active = false;
    assert.deepEqual(component.render(120), []);
    repaint.mock.resetCalls();
    t.mock.timers.tick(128);
    assert.equal(repaint.mock.callCount(), 0, "idle cancels the timer");
    active = true;
    component.render(120);
    component.stopAnimation();
    t.mock.timers.tick(128);
    assert.equal(repaint.mock.callCount(), 0, "explicit stop cancels the timer");
    component.render(120);
    component.dispose?.();
    t.mock.timers.tick(128);
    assert.equal(repaint.mock.callCount(), 0, "disposing an active component cancels its timer");
  }
});
