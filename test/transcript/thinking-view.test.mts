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

function windowOf(scroll: PeekScroll, total: number, lines = 6) {
  return scroll.resolve(total, lines);
}

test("click tables: single click cycles through peek, double click reaches full", () => {
  assert.equal(singleClickTarget("collapsed"), "peek");
  assert.equal(singleClickTarget("peek"), "collapsed");
  assert.equal(singleClickTarget("full"), "collapsed");
  assert.equal(doubleClickTarget("peek"), "full");
  assert.equal(doubleClickTarget("full"), "peek");
  assert.equal(doubleClickTarget("collapsed"), "full");
});

test("peek window follows the newest rows and reports what is clipped", () => {
  const scroll = new PeekScroll();
  // Short run: whole body visible, nothing clipped.
  assert.deepEqual(windowOf(scroll, 4), { top: 0, above: 0, below: 0 });
  // Long run: the last 6 rows, and the clipped count above them.
  assert.deepEqual(windowOf(scroll, 20), { top: 14, above: 14, below: 0 });
  // Empty body is legal (host builds the node before text arrives).
  assert.deepEqual(windowOf(scroll, 0), { top: 0, above: 0, below: 0 });
});

test("scrolling pins the absolute top so rows streamed below never move it", () => {
  const scroll = new PeekScroll();
  windowOf(scroll, 20);
  assert.equal(scroll.scrollBy(-4), true, "wheel up moves the window");
  assert.deepEqual(windowOf(scroll, 20), { top: 10, above: 10, below: 4 });
  assert.equal(scroll.following, false);
  // Six new rows arrive: the same text stays in view, the tail moves down.
  assert.deepEqual(windowOf(scroll, 26), { top: 10, above: 10, below: 10 });
  // Back to the bottom → following again.
  scroll.scrollBy(10);
  assert.equal(scroll.following, true);
  assert.deepEqual(windowOf(scroll, 26), { top: 20, above: 20, below: 0 });
});

test("a lone click waits for the double-click window, then applies the single target", (t) => {
  const { control, applied, click } = clicks(t);
  click("peek");
  assert.deepEqual(applied, [], "nothing happens while a second click is still possible");
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["collapsed"]);
  assert.equal(control.userView(), "collapsed");
});

test("a second click inside the window applies the double target instead", (t) => {
  const { applied, click } = clicks(t);
  click("peek");
  t.mock.timers.tick(120);
  click("peek", 11, 5);
  assert.deepEqual(applied, ["full"], "the pending single action is cancelled");
  t.mock.timers.tick(DOUBLE_CLICK_MS * 2);
  assert.deepEqual(applied, ["full"], "and never fires later");
  // The same gesture from the full view returns to the peek window.
  click("full");
  t.mock.timers.tick(120);
  click("full", 10, 6);
  assert.deepEqual(applied, ["full", "peek"]);
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

test("auto-fold drops a shape the user opened while the run streamed", (t) => {
  const { control, applied, click } = clicks(t);
  // Double click during streaming: peek → full.
  click("peek", 2, 2);
  t.mock.timers.tick(60);
  click("peek", 2, 2);
  assert.deepEqual(applied, ["full"]);
  assert.equal(control.userView(), "full");
  // The run ends: the completion policy forgets the shape, so the derived view
  // is the policy default (folded) again instead of a stale "full".
  control.foldOnEnd();
  assert.equal(control.userView(), undefined);
  // …and it does so ONCE: a click made AFTER the run finished must survive the
  // rebuilds that follow (the host rebuilds on every update).
  click("collapsed", 2, 2);
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.equal(control.userView(), "peek");
  control.foldOnEnd();
  assert.equal(control.userView(), "peek", "later rebuilds must not re-fold a choice the user made after the run ended");
});

