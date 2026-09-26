import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { createHistoryWindowSystem } from "../../src/chrome/history-window.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { altScreen, container, installCopyPrototypes, select } from "../helpers/ui-fixtures.mjs";

const HISTORY_ROW_BUDGET = 5000; // Independent contract, not the production constant.

class Block {
  renders = 0;
  clicked;
  constructor(id, count = 100) { this.id = id; this.count = count; }
  render(width) { this.renders++; return Array.from({ length: this.count }, (_, i) => `${this.id}:${i}`.slice(0, width)); }
  invalidate() {}
  setText(text) { this.id = text; }
  handleMouse(event) { if (event.type === "wheel") return; this.clicked = event.y; return { handled: true }; }
}
const longHistory = () => Array.from({ length: 120 }, (_, i) => new Block(i));
const renderCount = (blocks) => blocks.reduce((sum, block) => sum + block.renders, 0);

function setup(t, blocks = longHistory(), width = 80) {
  const source = container(...blocks);
  const scroll = new Tui.ScrollView(source, { primary: true, follow: "end" });
  const { tui, terminal } = altScreen(width, 20);
  tui.setLayoutRoot(scroll);
  const system = createHistoryWindowSystem(Tui);
  t.after(() => system.dispose());
  system.mount(tui, scroll);
  assert.equal(system.status().installed, true);
  const lines = () => tui.currentLayout.root.scrollContentLines;
  const render = () => {
    tui.doRender();
    assert.ok(lines().length <= HISTORY_ROW_BUDGET, "every committed window obeys the row budget");
  };
  const page = (direction) => {
    scroll.scrollTo(direction === "older" ? 0 : Number.MAX_SAFE_INTEGER, { disableFollow: true });
    scroll.scrollBy(direction === "older" ? -1 : 1);
    render();
  };
  const wheel = (direction) => {
    tui.handleTerminalInput(`\x1b[<${direction === "older" ? 64 : 65};10;5M`);
    render();
  };
  render();
  const selection = (row) => {
    tui.getSelectionBounds = () => row === null ? undefined : ({
      start: { row, col: 0, scrollView: scroll }, end: { row, col: 1, scrollView: scroll },
    });
  };
  return { source, scroll, tui, terminal, system, lines, render, page, wheel, selection };
}

test("initial replay and resize stop at a 5000-row suffix; warm scroll never renders source blocks", (t) => {
  const blocks = longHistory();
  const view = setup(t, blocks);
  assert.equal(view.lines().at(-1), "119:99");
  assert.equal(blocks[0].renders, 0, "old history must not be formatted then truncated");
  assert.equal(renderCount(blocks), 50, "only the retained suffix plus its boundary block is rendered");
  for (let i = 0; i < 5; i++) { view.scroll.scrollBy(-1); view.render(); }
  assert.equal(renderCount(blocks), 50);
  view.terminal.columns = 60;
  view.render();
  assert.equal(blocks[0].renders, 0);
  assert.equal(renderCount(blocks), 100);
});

test("paging and native jumps share a bounded window, preserve click coordinates and resume following", (t) => {
  const blocks = longHistory();
  const view = setup(t, blocks);
  const latest = view.lines().at(-1);
  view.page("older");
  assert.notEqual(view.lines().at(-1), latest);
  assert.equal(view.system.status().newer, true);
  assert.ok(view.system.status().evictedBlocks > 0);
  for (let i = 0; i < 4 && view.system.status().older; i++) {
    view.page("older");
  }
  assert.equal(view.lines()[0], "0:0");
  view.scroll.child.handleMouse({ y: 5, x: 0, width: 80, height: 20, type: "click", button: "left" });
  assert.equal(blocks[0].clicked, 5);
  const renders = renderCount(blocks);
  view.scroll.scrollTo(Number.MAX_SAFE_INTEGER, { disableFollow: true });
  view.scroll.scrollBy(1); // Queue a newer page without committing it.
  view.tui.scrollToBottom(); view.render();
  assert.equal(view.scroll.isFollowingEnd, true);
  assert.equal(view.scroll.scrollTop, view.scroll.contentHeight - view.scroll.viewportHeight);
  assert.equal(view.lines().at(-1), latest);
  assert.equal(renderCount(blocks) - renders, 50, "a native jump only renders the retained suffix");
  view.scroll.scrollTo(0, { disableFollow: true });
  view.scroll.scrollBy(-1); // The opposite jump must supersede this older page.
  view.tui.scrollToTop(); view.render();
  assert.equal(view.scroll.isFollowingEnd, false);
  assert.equal(view.lines()[0], "0:0");
  assert.equal(view.scroll.scrollTop, 0);
  for (let i = 0; i < 4 && view.system.status().newer; i++) {
    view.page("newer");
  }
  assert.equal(view.lines().at(-1), latest);
  assert.equal(view.system.status().newer, false);
  view.scroll.scrollTo(Number.MAX_SAFE_INTEGER); view.render();
  view.source.addChild(new Block("appended", 200)); view.render();
  assert.equal(view.lines().at(-1), "appended:199", "paging back to latest resumes following new output");
});

test("selection freezes source mutations until release; replacement and disposal preserve ownership", (t) => {
  const block = new Block("before", 2);
  const view = setup(t, [block]);
  const committed = view.lines();
  view.selection(0);
  block.setText("after");
  view.source.addChild(new Block("append", 1));
  view.render();
  assert.equal(view.lines(), committed);
  view.selection(null); view.render();
  assert.deepEqual(view.lines(), ["after:0", "after:1", "append:0"]);
  block.setText("settled");
  view.render();
  assert.deepEqual(view.lines(), ["settled:0", "settled:1", "append:0"], "setText invalidates without a source-list change");

  view.source.clear(); view.source.addChild(new Block("replacement", 1)); view.render();
  assert.deepEqual(view.lines(), ["replacement:0"]);
  view.source.children[0] = new Block("header", 1); view.render();
  assert.deepEqual(view.lines(), ["header:0"], "direct host replacement invalidates the window");
  view.selection(0);
  view.tui.clearTextSelection = t.mock.fn(() => view.selection(null));
  view.source.addChild(new Block("reply", 1));
  for (const listener of view.tui.inputListeners) listener("\r");
  assert.equal(view.tui.clearTextSelection.mock.callCount(), 1);
  view.render();
  assert.deepEqual(view.lines(), ["header:0", "reply:0"], "submission releases selection before command output");
  view.system.dispose();
  assert.equal(view.scroll.child, view.source);
  assert.equal(Object.hasOwn(block, "setText"), false, "observed methods restored");
  for (const key of ["scrollToStart", "scrollToEnd", "updateLayout"]) {
    assert.equal(Object.hasOwn(view.scroll, key), false, `${key}: native method restored`);
  }
  assert.equal(view.scroll.updateLayout, Tui.ScrollView.prototype.updateLayout);
});

for (const update of ["append", "stream"]) {
  test(`${update} while reading: wheel-up from a short tail page stays near the reading position`, (t) => {
    const blocks = longHistory();
    const view = setup(t, blocks);
    view.wheel("older");
    if (update === "append") view.source.addChild(new Block("appended", 1));
    else { blocks.at(-1).count++; blocks.at(-1).invalidate(); }
    view.render();
    for (let i = 0; i < 3; i++) view.wheel("newer");
    assert.equal(view.scroll.contentHeight, 22, "paging into new output leaves a short tail and a larger thumb");
    assert.equal(view.scroll.scrollTop, 0);

    view.wheel("older");
    assert.equal(view.scroll.contentHeight, HISTORY_ROW_BUDGET);
    assert.equal(view.scroll.scrollTop, HISTORY_ROW_BUDGET - view.scroll.viewportHeight,
      "restore against the new page height, not the old 22-row tail");
    assert.equal(view.lines()[view.scroll.scrollTop], "119:81", "keep the overlapping recent messages visible");
    assert.equal(view.tui.currentLayout.root.children[0].rect.y, -view.scroll.scrollTop,
      "the first committed frame uses the restored position for native geometry");
    const top = view.scroll.scrollTop;
    view.wheel("older");
    assert.equal(view.scroll.scrollTop, top - 1, "a committed target must not override later wheel events");

    view.tui.scrollToBottom(); view.render();
    view.source.addChild(new Block("latest", 1)); view.render();
    assert.equal(view.lines().at(-1), "latest:0");
    assert.equal(view.scroll.isFollowingEnd, true);
  });
}

test("content reflow restores the reading anchor after the new content and viewport sizes are committed", (t) => {
  const prefix = new Block("prefix", 30);
  const view = setup(t, [prefix, new Block("body", 100)]);
  view.scroll.scrollBy(-30); view.render();
  assert.equal(view.lines()[view.scroll.scrollTop], "body:50");
  prefix.count = 300; prefix.invalidate();
  view.terminal.rows = 40;
  view.render();
  assert.equal(view.scroll.scrollTop, 350, "a grown prefix can move the anchor beyond the old scroll limit");
  assert.equal(view.lines()[view.scroll.scrollTop], "body:50");
  assert.equal(view.scroll.isFollowingEnd, false);
  prefix.count = 20; prefix.invalidate();
  view.render();
  assert.equal(view.scroll.scrollTop, 70);
  assert.equal(view.lines()[view.scroll.scrollTop], "body:50");
  assert.equal(view.scroll.isFollowingEnd, false, "clamping during shrink must not resume following");
});

test("giant boundary block is sliced with collectible native/mirror caches and exact selected text", (t) => {
  installCopyPrototypes(t);
  const text = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n");
  const block = new Tui.Text(text, 0, 0);
  const view = setup(t, [block]);
  assert.equal(view.lines().at(-1).trim(), "line 5999");
  assert.equal(view.system.status().cachedBlocks, 0, "an oversized full native block is not retained");
  assert.ok(!block.cachedLines, "native rows evicted");
  const rows = view.lines();
  assert.ok(productFor(rows));
  const result = select(view.tui.currentLayout, rows.length - 2);
  assert.equal(result.text, "line 5998\nline 5999");
  assert.equal(result.nativeRows, 0);
});

test("selection holds an uncommitted page position until its new rows can be laid out", (t) => {
  const view = setup(t);
  view.scroll.scrollTo(0, { disableFollow: true }); view.render();
  const committed = view.lines();
  view.scroll.scrollBy(-1);
  view.selection(1);
  view.render();
  assert.equal(view.lines(), committed);
  assert.equal(view.scroll.scrollTop, 0, "a pending target must not move the frozen frame");
  view.selection(null); view.render();
  assert.notEqual(view.lines(), committed);
  assert.equal(view.scroll.scrollTop, view.scroll.contentHeight - view.scroll.viewportHeight);
});

test("dispose cancels a pending position without replacing a later layout wrapper", (t) => {
  const view = setup(t);
  const captured = view.scroll.updateLayout;
  const foreign = function (...args) { return captured.apply(this, args); };
  view.scroll.updateLayout = foreign;
  view.scroll.scrollTo(0, { disableFollow: true });
  view.scroll.scrollBy(-1);
  view.system.dispose();
  assert.equal(view.scroll.updateLayout, foreign);
  view.scroll.updateLayout(100, 20, () => {});
  assert.equal(view.scroll.scrollTop, 0, "a captured hook must not apply a disposed window's pending target");
});
