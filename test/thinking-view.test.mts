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
  peekHintText,
  PeekScroll,
  resolvePeekLines,
  singleClickTarget,
} from "../src/thinking-view.ts";
import type { ThinkingView } from "../src/thinking-view.ts";

const NOW = 1_700_000_000_000;

function windowOf(scroll: PeekScroll, total: number, lines = 6) {
  return scroll.resolve(total, lines);
}

test("single click moves collapsed ↔ peek and full → collapsed", () => {
  assert.equal(singleClickTarget("collapsed"), "peek");
  assert.equal(singleClickTarget("peek"), "collapsed");
  assert.equal(singleClickTarget("full"), "collapsed");
});

test("double click toggles peek ↔ full and opens a collapsed run fully", () => {
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

test("scrolling stops at both ends and says so", () => {
  const scroll = new PeekScroll();
  windowOf(scroll, 20);
  assert.equal(scroll.scrollBy(5), false, "already at the newest row");
  assert.equal(scroll.scrollBy(-100), true);
  assert.deepEqual(windowOf(scroll, 20), { top: 0, above: 0, below: 14 });
  assert.equal(scroll.scrollBy(-1), false, "already at the oldest row");
  assert.equal(scroll.scrollBy(Number.NaN), false);
  assert.equal(scroll.scrollBy(0), false);
  scroll.reset();
  assert.equal(scroll.following, true);
  assert.deepEqual(windowOf(scroll, 20), { top: 14, above: 14, below: 0 });
});

test("hint text names both clipped sides and the way out", () => {
  assert.equal(peekHintText(14, 0, 20), "… 14 above of 20 lines (scroll · double-click for all)");
  assert.ok(peekHintText(10, 4, 20).includes("10 above, 4 below"));
  assert.ok(peekHintText(10, 4, 20).includes("double-click"));
});

test("peek height comes from config but is clamped", () => {
  assert.equal(resolvePeekLines(6), 6);
  assert.equal(resolvePeekLines(1), 1);
  assert.equal(resolvePeekLines(999), 40);
  assert.equal(resolvePeekLines(0), 1);
  assert.equal(resolvePeekLines(-3), 1);
  assert.equal(resolvePeekLines("8"), 6);
  assert.equal(resolvePeekLines(undefined), 6);
  assert.equal(resolvePeekLines(Number.NaN), 6);
});

test("a lone click waits for the double-click window, then applies the single target", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "peek", apply: (v) => applied.push(v) });
  assert.deepEqual(applied, [], "nothing happens while a second click is still possible");
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["collapsed"]);
  assert.equal(control.userView(), "collapsed");
});

test("a second click inside the window applies the double target instead", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  const apply = (v: ThinkingView) => applied.push(v);
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "peek", apply });
  t.mock.timers.tick(120);
  control.handleClick({ at: Date.now(), x: 11, y: 5 }, { fallback: "peek", apply });
  assert.deepEqual(applied, ["full"], "the pending single action is cancelled");
  t.mock.timers.tick(DOUBLE_CLICK_MS * 2);
  assert.deepEqual(applied, ["full"], "and never fires later");
  // The same gesture from the full view returns to the peek window.
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "full", apply });
  t.mock.timers.tick(120);
  control.handleClick({ at: Date.now(), x: 10, y: 6 }, { fallback: "full", apply });
  assert.deepEqual(applied, ["full", "peek"]);
});

test("clicks apart in time or position stay two single clicks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  const apply = (v: ThinkingView) => applied.push(v);
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "collapsed", apply });
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["peek"]);
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "peek", apply });
  t.mock.timers.tick(DOUBLE_CLICK_MS + 1);
  assert.deepEqual(applied, ["peek", "collapsed"]);
  // Far apart in space: not a double click even inside the window.
  control.handleClick({ at: Date.now(), x: 10, y: 5 }, { fallback: "collapsed", apply });
  t.mock.timers.tick(100);
  control.handleClick({ at: Date.now(), x: 60, y: 5 }, { fallback: "collapsed", apply });
  assert.deepEqual(applied, ["peek", "collapsed", "peek"], "the too-far click lands at once, not dropped");
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.deepEqual(applied, ["peek", "collapsed", "peek", "collapsed"], "and the second click keeps its own wait");
});

test("cancel drops a pending click and policy records are explicit", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  control.handleClick({ at: Date.now(), x: 1, y: 1 }, { fallback: "peek", apply: (v) => applied.push(v) });
  control.cancel();
  t.mock.timers.tick(DOUBLE_CLICK_MS * 2);
  assert.deepEqual(applied, [], "a cancelled click never fires");
  // Only a click is stored; a fresh run has no user choice at all.
  assert.equal(control.userView(), undefined);
  control.handleClick({ at: Date.now(), x: 3, y: 3 }, { fallback: "peek", apply: () => {} });
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.equal(control.userView(), "collapsed");
  // Auto-fold at the end of a run drops the user's shape — once.
  control.foldOnEnd();
  assert.equal(control.userView(), undefined);
});

test("auto-fold drops a shape the user opened while the run streamed", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  const apply = (v: ThinkingView) => applied.push(v);
  // Double click during streaming: peek → full.
  control.handleClick({ at: Date.now(), x: 2, y: 2 }, { fallback: "peek", apply });
  t.mock.timers.tick(60);
  control.handleClick({ at: Date.now(), x: 2, y: 2 }, { fallback: "peek", apply });
  assert.deepEqual(applied, ["full"]);
  assert.equal(control.userView(), "full");
  // The run ends: the completion policy forgets the shape, so the derived view
  // is the policy default (folded) again instead of a stale "full".
  control.foldOnEnd();
  assert.equal(control.userView(), undefined);
  // …and it does so ONCE: a click made AFTER the run finished must survive the
  // rebuilds that follow (the host rebuilds on every update).
  control.handleClick({ at: Date.now(), x: 2, y: 2 }, { fallback: "collapsed", apply });
  t.mock.timers.tick(DOUBLE_CLICK_MS);
  assert.equal(control.userView(), "peek");
  control.foldOnEnd();
  assert.equal(control.userView(), "peek", "later rebuilds must not re-fold a choice the user made after the run ended");
});

test("every run owns its own view and scroll position", () => {
  const a = createThinkingViewControl();
  const b = createThinkingViewControl();
  a.scroll.resolve(20, 6);
  a.scroll.scrollBy(-3);
  assert.deepEqual(b.scroll.resolve(20, 6), { top: 14, above: 14, below: 0 }, "untouched run still follows the tail");
  assert.deepEqual(a.scroll.resolve(20, 6), { top: 11, above: 11, below: 3 });
});
