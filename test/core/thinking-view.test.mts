// Reasoning view: immediate left/right gestures, tail following, scroll pinning
// and once-only completion folding. Mouse choices are display-only.
import test from "node:test";
import assert from "node:assert/strict";
import { createThinkingViewControl, PeekScroll } from "../../src/thinking-view.ts";
import type { ThinkingView } from "../../src/thinking-view.ts";
import { CodexThinkingClickableComponent } from "../../src/chrome/transcript-components.ts";

function clicks() {
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  return {
    control, applied,
    click: (button: "left" | "right", visible: ThinkingView) =>
      new CodexThinkingClickableComponent({ render: () => [], invalidate() {} }, control, visible, (v) => applied.push(v))
        .handleMouse({ type: "click", button, x: 10, y: 5, screenX: 10, screenY: 5 }),
  };
}

test("left toggles collapsed/peek immediately and leaves full unchanged; right toggles full/closed", () => {
  const { control, applied, click } = clicks();
  click("left", "collapsed");
  assert.equal(control.userView(), "peek");
  click("left", "peek");
  assert.equal(control.userView(), "collapsed");
  click("left", "collapsed");
  click("right", "peek");
  assert.equal(control.userView(), "full");
  click("left", "full");
  assert.deepEqual(applied, ["peek", "collapsed", "peek", "full"], "full left click is consumed without a transition");
  click("right", "full");
  assert.equal(control.userView(), "collapsed");
  click("right", "collapsed");
  assert.equal(control.userView(), "full");
  click("right", "full");
  assert.deepEqual(applied, ["peek", "collapsed", "peek", "full", "collapsed", "full", "collapsed"]);
});

test("right press claims the host gesture without applying it before the eventual click", () => {
  const control = createThinkingViewControl();
  const applied: ThinkingView[] = [];
  const component = new CodexThinkingClickableComponent({ render: () => [], invalidate() {} }, control, "collapsed", v => applied.push(v));
  const pointer = { button: "right" as const, x: 3, y: 0, screenX: 3, screenY: 0 };
  assert.equal(component.handleMouse({ type: "press", ...pointer })?.handled, true, "Pi only synthesizes right click after a handled press");
  assert.deepEqual(applied, [], "press must not rebuild the click target");
  component.handleMouse({ type: "release", ...pointer });
  assert.deepEqual(applied, []);
  component.handleMouse({ type: "click", ...pointer });
  assert.deepEqual(applied, ["full"], "one press/release/click gesture applies once");
});

test("gestures use the visible shape after a global toggle rather than an old mouse choice", () => {
  const { control, applied, click } = clicks();
  click("right", "collapsed");
  // Ctrl+T can hide a run without clearing its remembered full choice.
  click("right", "collapsed");
  assert.deepEqual(applied, ["full", "full"], "a hidden run must reopen even if its old choice was already full");
  click("right", "full");
  // Ctrl+T now shows the whole body while the last mouse choice is collapsed.
  click("left", "full");
  assert.deepEqual(applied, ["full", "full", "collapsed"], "left does not alter a globally shown full body");
  assert.equal(control.userView(), "collapsed");
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

test("completion folds once without resetting a later completed-run choice", () => {
  const { control, applied, click } = clicks();
  click("right", "peek");
  assert.equal(control.userView(), "full");
  control.foldOnEnd();
  assert.equal(control.userView(), undefined, "completion clears the streaming choice");
  click("left", "collapsed");
  assert.equal(control.userView(), "peek");
  control.foldOnEnd();
  assert.equal(control.userView(), "peek", "later folds preserve the completed-run choice");
  assert.deepEqual(applied, ["full", "peek"]);
});
