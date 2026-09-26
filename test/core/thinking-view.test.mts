// thinking-view.test.mts — the reasoning peek window's pure state machine.
// Pins the click table, the delayed single click (the host rebuilds the block
// between the two clicks of a double click), the tail-following window, and the
// scroll pinning that keeps text still while rows stream in below it.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createThinkingViewControl,
  DOUBLE_CLICK_MS,
  doubleClickTarget,
  PeekScroll,
  singleClickTarget,
} from "../../src/thinking-view.ts";
import type { ThinkingView } from "../../src/thinking-view.ts";

const NOW = 1_700_000_000_000;

function clicks(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  t.after(() => control.cancel());
  return {
    control, applied,
    click: (fallback: ThinkingView, x = 10, y = 5) =>
      control.handleClick({ at: Date.now(), x, y }, { fallback, apply: (v) => applied.push(v) }),
  };
}

test("click tables: single click cycles through peek, double click reaches full", () => {
  assert.equal(singleClickTarget("collapsed"), "peek");
  assert.equal(singleClickTarget("peek"), "collapsed");
  assert.equal(singleClickTarget("full"), "collapsed");
  assert.equal(doubleClickTarget("peek"), "full");
  assert.equal(doubleClickTarget("full"), "peek");
  assert.equal(doubleClickTarget("collapsed"), "full");
});

test("peek follows the tail until scrolling pins it, then resumes at the bottom", () => {
  const scroll = new PeekScroll();
  assert.deepEqual(scroll.resolve(0, 6), { top: 0, above: 0, below: 0 });
  assert.deepEqual(scroll.resolve(4, 6), { top: 0, above: 0, below: 0 });
  assert.deepEqual(scroll.resolve(20, 6), { top: 14, above: 14, below: 0 });
  assert.equal(scroll.scrollBy(-4), true);
  assert.deepEqual(scroll.resolve(20, 6), { top: 10, above: 10, below: 4 });
  assert.deepEqual(scroll.resolve(26, 6), { top: 10, above: 10, below: 10 });
  scroll.scrollBy(10);
  assert.deepEqual(scroll.resolve(26, 6), { top: 20, above: 20, below: 0 });
  assert.deepEqual(scroll.resolve(28, 6), { top: 22, above: 22, below: 0 });
});

test("double clicks cancel pending singles; completion folds once without resetting later choices", (t) => {
  const { control, applied, click } = clicks(t);
  click("peek");
  t.mock.timers.tick(120);
  click("peek", 11, 5);
  assert.deepEqual(applied, ["full"], "the pending single action is cancelled");
  t.mock.timers.tick(DOUBLE_CLICK_MS * 2);
  assert.deepEqual(applied, ["full"], "and never fires later");
  control.foldOnEnd();
  assert.equal(control.userView(), undefined, "completion clears the streaming choice");
  // The same gesture from the full view returns to the peek window.
  click("full");
  t.mock.timers.tick(120);
  click("full", 10, 6);
  assert.deepEqual(applied, ["full", "peek"]);
  control.foldOnEnd();
  assert.equal(control.userView(), "peek", "later folds preserve the user's completed-run choice");
});

test("clicks apart in time or position stay two single clicks", (t) => {
  const { control, applied, click } = clicks(t);
  click("collapsed");
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["peek"]);
  click("peek");
  t.mock.timers.tick(DOUBLE_CLICK_MS + 1);
  assert.deepEqual(applied, ["peek", "collapsed"]);
  // Far apart in space: not a double click even inside the window.
  click("collapsed");
  t.mock.timers.tick(100);
  click("collapsed", 60, 5);
  assert.deepEqual(applied, ["peek", "collapsed", "peek"], "the too-far click lands at once, not dropped");
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["peek", "collapsed", "peek", "collapsed"], "and the second click keeps its own wait");
  // cancel() drops a pending click entirely; a fresh run has no user choice.
  control.cancel();
  assert.equal(createThinkingViewControl().userView(), undefined);
});

