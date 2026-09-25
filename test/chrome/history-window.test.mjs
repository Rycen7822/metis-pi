import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { HISTORY_ROW_BUDGET } from "../../src/chrome/history-window.ts";
import { createFullscreenLayout } from "../../src/chrome/fullscreen-layout.ts";
import { createSelectionCopySystem } from "../../src/selection-copy/index.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { SelectionSerializer } from "../../src/selection-copy/serialize.ts";

createSelectionCopySystem({ prototypes: { Text: Tui.Text.prototype, Markdown: Tui.Markdown.prototype,
  Container: Tui.Container.prototype, Box: Tui.Box.prototype, MouseRegion: Tui.MouseRegion.prototype },
  fns: { visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences, wrapTextWithAnsi: Tui.wrapTextWithAnsi } }).wrapPrototypes();

class Block {
  renders = 0;
  invalidations = 0;
  clicked;
  constructor(id, count = 100) { this.id = id; this.count = count; }
  render(width) { this.renders++; return Array.from({ length: this.count }, (_, i) => `${this.id}:${i}`.slice(0, width)); }
  invalidate() { this.invalidations++; }
  setText(text) { this.id = text; }
  handleMouse(event) { this.clicked = event.y; return { handled: true }; }
}
const longHistory = () => Array.from({ length: 120 }, (_, i) => new Block(i));
const renderCount = (blocks) => blocks.reduce((sum, block) => sum + block.renders, 0);

function setup(t, blocks = longHistory(), width = 80) {
  const source = new Tui.Container();
  blocks.forEach((block) => source.addChild(block));
  const scroll = new Tui.ScrollView(source, { primary: true, follow: "end" });
  const terminal = { columns: width, rows: 20, write() {} };
  const tui = new Tui.TuiAltScreen(terminal);
  tui.requestRender = () => {};
  tui.beforeTerminalStart();
  tui.setLayoutRoot(scroll);
  const system = createFullscreenLayout(Tui, { margin: 0, minWidth: 0 });
  assert.equal(system.installOnTui(tui), true);
  t.after(() => system.dispose());
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
  render();
  return { source, scroll, tui, terminal, system, lines, render, page };
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

test("wheel paging reaches both ends, evicts old caches and maps clicks through boundary slices", (t) => {
  const blocks = longHistory();
  const view = setup(t, blocks);
  const latest = view.lines().at(-1);
  view.page("older");
  assert.notEqual(view.lines().at(-1), latest);
  assert.equal(view.system.status().history.newer, true);
  assert.ok(view.system.status().history.evictedBlocks > 0);
  for (let i = 0; i < 4 && view.system.status().history.older; i++) {
    view.page("older");
  }
  assert.equal(view.lines()[0], "0:0");
  view.scroll.child.handleMouse({ y: 5, x: 0, width: 80, height: 20, type: "click", button: "left" });
  assert.equal(blocks[0].clicked, 5);
  for (let i = 0; i < 4 && view.system.status().history.newer; i++) {
    view.page("newer");
  }
  assert.equal(view.lines().at(-1), latest);
  assert.equal(view.system.status().history.newer, false);
  view.scroll.scrollTo(Number.MAX_SAFE_INTEGER); view.render();
  view.source.addChild(new Block("appended", 200)); view.render();
  assert.equal(view.lines().at(-1), "appended:199", "paging back to latest resumes following new output");
});

test("source updates, append, replacement and disposal preserve ownership", (t) => {
  const block = new Block("before", 2);
  const view = setup(t, [block]);
  block.setText("after"); view.render();
  assert.deepEqual(view.lines(), ["after:0", "after:1"]);
  view.source.addChild(new Block("new", 1)); view.render();
  assert.equal(view.lines().at(-1), "new:0");
  view.source.clear(); view.source.addChild(new Block("replacement", 1)); view.render();
  assert.deepEqual(view.lines(), ["replacement:0"]);
  view.source.children.splice(0, 1, new Block("spliced", 1)); view.render();
  assert.deepEqual(view.lines(), ["spliced:0"]);
  view.source.children[0] = new Block("header", 1); view.render();
  assert.deepEqual(view.lines(), ["header:0"]);
  view.system.dispose();
  assert.equal(view.scroll.child, view.source);
  assert.equal(Object.hasOwn(block, "setText"), false, "observed methods restored");
  const unopened = createFullscreenLayout({}, { margin: 0, minWidth: 0 });
  assert.doesNotThrow(() => { unopened.dispose(); unopened.dispose(); });
});

test("giant boundary block is sliced with collectible native/mirror caches and exact selected text", (t) => {
  const text = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join("\n");
  const block = new Tui.Text(text, 0, 0);
  const view = setup(t, [block]);
  assert.equal(view.lines().at(-1).trim(), "line 5999");
  assert.equal(view.system.status().history.cachedBlocks, 0, "an oversized full native block is not retained");
  assert.ok(!block.cachedLines, "native rows evicted");
  const rows = view.lines();
  assert.ok(productFor(rows));
  const result = new SelectionSerializer({ visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences }).serialize(view.tui.currentLayout, {
      scrollView: view.scroll, startRow: rows.length - 2, endRow: rows.length - 1, sourceLines: rows,
      columnsFor: (r) => ({ start: 0, end: Tui.visibleWidth(rows[r]) }),
    });
  assert.equal(result.text, "line 5998\nline 5999");
  assert.equal(result.nativeRows, 0);
});

test("active selection pins the committed rows until released", (t) => {
  const block = new Block("before", 2);
  const view = setup(t, [block]);
  const committed = view.lines();
  view.tui.getSelectionBounds = () => ({ start: { row: 0, col: 0, scrollView: view.scroll }, end: { row: 0, col: 1, scrollView: view.scroll } });
  block.setText("after"); view.source.addChild(new Block("append", 1));
  view.render();
  assert.equal(view.lines(), committed);
  view.tui.getSelectionBounds = () => undefined; view.render();
  assert.deepEqual(view.lines(), ["after:0", "after:1", "append:0"]);
});

test("native top and bottom navigation jump across pages within the row budget", (t) => {
  const blocks = longHistory();
  const view = setup(t, blocks);
  view.page("older");
  view.tui.scrollToBottom(); view.render();
  assert.equal(view.lines().at(-1), "119:99");
  view.tui.scrollToTop(); view.render();
  assert.equal(view.lines()[0], "0:0");
  assert.equal(view.scroll.scrollTop, 0);
  const renders = renderCount(blocks);
  view.tui.scrollToBottom(); view.render();
  assert.equal(view.lines().at(-1), "119:99");
  assert.equal(renderCount(blocks) - renders, 50);
  view.system.dispose();
  assert.equal(Object.hasOwn(view.scroll, "scrollToStart"), false);
  assert.equal(Object.hasOwn(view.scroll, "scrollToEnd"), false);
});

test("submitting input releases the selected window so command output can appear", (t) => {
  const view = setup(t, [new Block("first", 1)]);
  view.tui.getSelectionBounds = () => ({ start: { row: 0, col: 0, scrollView: view.scroll }, end: { row: 0, col: 1, scrollView: view.scroll } });
  let cleared = false;
  view.tui.clearTextSelection = () => { cleared = true; view.tui.getSelectionBounds = () => undefined; };
  view.source.addChild(new Block("reply", 1));
  for (const listener of view.tui.inputListeners) listener("\r");
  assert.equal(cleared, true);
  view.render();
  assert.equal(view.lines().at(-1), "reply:0");
});
