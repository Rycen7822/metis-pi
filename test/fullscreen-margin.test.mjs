// fullscreen-margin.test.mjs — Codex-style side gutters in fullscreen mode,
// against the REAL TuiAltScreen: render inset, mouse hit-testing through the
// shifted frame, narrow-terminal fallback, idempotent install, dispose, and
// selection-copy regression (logical copy stays exact through the offset frame).
import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { createFullscreenMargin, FULLSCREEN_MARGIN_OWNER } from "../src/chrome/fullscreen-margin.ts";
import { createHistoryWindowSystem } from "../src/chrome/history-window.ts";
import { createSelectionCopySystem } from "../src/selection-copy/index.ts";
import { fakeTerminal, sgr } from "./helpers.mjs";

const MARGIN_HOST = { HStack: Tui.HStack, Spacer: Tui.Spacer };

function makeAltScreen(width) {
  const terminal = fakeTerminal(width);
  const tui = new Tui.TuiAltScreen(terminal);
  tui.beforeTerminalStart();
  tui.setCopyOnSelect(false);
  return { tui, terminal };
}

function screenLines(tui) {
  return tui.previousScreen.map((line) => Tui.stripTerminalSequences(line).trimEnd());
}

test("auto scrollbar keeps colored history inside both gutters on wheel input and resize", (t) => {
  const { tui, terminal } = makeAltScreen(60);
  tui.requestRender = () => {};
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  const history = createHistoryWindowSystem(Tui);
  t.after(() => { history.dispose(); margin.dispose(); });
  margin.installOnTui(tui);
  const colors = ["\x1b[48;2;32;55;40m", "\x1b[48;2;70;30;28m"];
  const source = { render: (width) => Array.from({ length: 6000 }, (_, i) =>
    `${colors[i % 2]}${`diff ${i}`.padEnd(width)}\x1b[49m`) };
  const scroll = new Tui.ScrollView(source, { primary: true, follow: "end", scrollbar: "auto" });
  tui.setLayoutRoot(scroll);
  history.installOnTui(tui);
  t.after(() => scroll.hideTransientScrollbar());
  const checkFrame = () => {
    tui.doRender();
    const diffLines = tui.previousScreen.filter((line) => line.includes("diff "));
    assert.ok(diffLines.length > 1, "colored history remains visible");
    for (const line of diffLines) {
      // Inspect printed cells, not stripped text: spaces can carry the leak.
      const backgrounds = [];
      let background;
      for (const part of line.split(/(\x1b\[[0-9;]*m|\x1b\]8;;\x07)/)) {
        if (part === "\x1b[0m" || part === "\x1b[49m") background = undefined;
        else if (colors.includes(part)) background = part;
        else if (!part.startsWith("\x1b")) backgrounds.push(...Array(part.length).fill(background));
      }
      assert.equal(backgrounds.length, terminal.columns);
      assert.deepEqual(backgrounds.slice(0, 2), [undefined, undefined]);
      assert.ok(colors.includes(backgrounds[3]), "diff background remains painted");
      assert.deepEqual(backgrounds.slice(-2), [undefined, undefined], "right gutter stays uncolored");
    }
  };
  checkFrame();
  for (const wheel of [64, 65, 64]) {
    tui.handleTerminalInput(sgr(wheel, 10, 5));
    assert.equal(scroll.isScrollbarVisible, true);
    checkFrame();
  }
  terminal.columns = 72;
  terminal.rows = 30;
  checkFrame();
  scroll.hideTransientScrollbar();
  checkFrame();
});

test("install wraps setLayoutRoot: content is inset by the margin, gutters blank", (t) => {
  const { tui } = makeAltScreen(60);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(tui), true);
  const root = new Tui.Container();
  root.addChild(new Tui.Text("hello margin world", 0, 0));
  tui.setLayoutRoot(root);
  assert.notEqual(tui.layoutRoot, root, "layout root is the wrapper");
  assert.equal(tui.layoutRoot[FULLSCREEN_MARGIN_OWNER], root, "wrapper carries the real root");
  tui.doRender();
  const line = screenLines(tui).find((l) => l.includes("hello margin world"));
  assert.ok(line, "content rendered");
  assert.equal(line.indexOf("hello"), 2, `content starts at column 2, got ${JSON.stringify(line)}`);
});

test("retroactive: a root mounted before install is wrapped too", (t) => {
  const { tui } = makeAltScreen(60);
  const root = new Tui.Container();
  root.addChild(new Tui.Text("already mounted", 0, 0));
  tui.setLayoutRoot(root);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 3, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(tui), true);
  assert.equal(tui.layoutRoot[FULLSCREEN_MARGIN_OWNER], root, "existing root wrapped at install");
  tui.doRender();
  const line = screenLines(tui).find((l) => l.includes("already mounted"));
  assert.equal(line.indexOf("already"), 3, `content starts at column 3, got ${JSON.stringify(line)}`);
});

test("mouse click through the shifted frame hits MouseRegion; gutter click is a no-op", (t) => {
  const { tui } = makeAltScreen(60);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  margin.installOnTui(tui);
  const clicks = [];
  const region = new Tui.MouseRegion(new Tui.Text("click target row", 0, 0), (event) => {
    clicks.push({ type: event.type, x: event.x, y: event.y, width: event.width });
    return { render: true };
  });
  const root = new Tui.Container();
  root.addChild(region);
  tui.setLayoutRoot(root);
  tui.doRender();
  const screen = screenLines(tui);
  const row = screen.findIndex((l) => l.includes("click target row"));
  assert.ok(row >= 0, "target row rendered");
  const col = screen[row].indexOf("click") + 1; // SGR coords are 1-based
  assert.equal(col, 3, "target sits past the 2-column gutter");
  // Press + same-point release → synthesized click, dispatched via frame rects.
  tui.handleTerminalInput(sgr(0, col, row + 1));
  tui.handleTerminalInput(sgr(0, col, row + 1, true));
  const click = clicks.find((c) => c.type === "click");
  assert.ok(click, `click reached the region, got ${JSON.stringify(clicks)}`);
  assert.equal(click.x, 0, "local x is translated past the gutter");
  assert.equal(click.width, 56, "local width excludes both gutters");
  clicks.length = 0;
  tui.handleTerminalInput(sgr(0, 1, row + 1));
  tui.handleTerminalInput(sgr(0, 1, row + 1, true));
  assert.equal(clicks.length, 0, `gutter click must not hit the region, got ${JSON.stringify(clicks)}`);
});

test("narrow terminal: gutters vanish below minWidth", (t) => {
  const { tui } = makeAltScreen(30);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  margin.installOnTui(tui);
  const root = new Tui.Container();
  root.addChild(new Tui.Text("narrow full width", 0, 0));
  tui.setLayoutRoot(root);
  tui.doRender();
  const line = screenLines(tui).find((l) => l.includes("narrow full width"));
  assert.equal(line.indexOf("narrow"), 0, `narrow terminal keeps full width, got ${JSON.stringify(line)}`);
});

test("idempotent: repeated installs wrap once", (t) => {
  const { tui } = makeAltScreen(60);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(tui), true);
  assert.equal(margin.installOnTui(tui), true, "second install is a no-op success");
  const root = new Tui.Container();
  root.addChild(new Tui.Text("once", 0, 0));
  tui.setLayoutRoot(root);
  const wrapper = tui.layoutRoot;
  assert.equal(wrapper[FULLSCREEN_MARGIN_OWNER], root, "wrapped directly, not nested");
  // Re-setting the wrapper itself (e.g. ensureRootWrapped path) must not nest.
  tui.setLayoutRoot(wrapper);
  assert.equal(tui.layoutRoot[FULLSCREEN_MARGIN_OWNER], root, "wrapper never re-wrapped");
});

test("dispose restores the prototype method and unwraps the live root", (t) => {
  const { tui } = makeAltScreen(60);
  const proto = Object.getPrototypeOf(tui);
  const nativeSet = proto.setLayoutRoot;
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  margin.installOnTui(tui);
  const root = new Tui.Container();
  root.addChild(new Tui.Text("restore me", 0, 0));
  tui.setLayoutRoot(root);
  assert.notEqual(tui.layoutRoot, root);
  margin.dispose();
  assert.equal(proto.setLayoutRoot, nativeSet, "prototype method restored");
  assert.equal(tui.layoutRoot, root, "live root unwrapped");
  tui.doRender();
  const line = screenLines(tui).find((l) => l.includes("restore me"));
  assert.equal(line.indexOf("restore"), 0, "render is full-width again");
});

test("regular renderer is skipped untouched", (t) => {
  class FakeRegular {
    mode = "regular";
    layoutRoot;
    setLayoutRoot(component) { this.layoutRoot = component; }
  }
  const regular = new FakeRegular();
  const nativeSet = Object.getPrototypeOf(regular).setLayoutRoot;
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(regular), false);
  assert.equal(margin.status().reason, "renderer is not fullscreen");
  assert.equal(Object.getPrototypeOf(regular).setLayoutRoot, nativeSet, "regular prototype untouched");
});

test("margin 0 disables without touching anything", (t) => {
  const { tui } = makeAltScreen(60);
  const proto = Object.getPrototypeOf(tui);
  const nativeSet = proto.setLayoutRoot;
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 0, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(tui), false);
  assert.equal(proto.setLayoutRoot, nativeSet);
});

// ---------------------------------------------------------------------------
// Selection-copy regression: logical copy must stay exact through the offset
// frame (the gutter columns are layout, not content).
// ---------------------------------------------------------------------------

const theme = {
  bold: (t) => t, italic: (t) => t, underline: (t) => t, strikethrough: (t) => t,
  heading: (t) => t, code: (t) => t, codeBlock: (t) => t, codeBlockBorder: (t) => t,
  codeBlockIndent: "  ", listBullet: (t) => t, quote: (t) => t, quoteBorder: (t) => t,
  hr: (t) => t, link: (t) => t,
};

// One system per process: the prototype wraps and the instance serializer are
// owner-symbol singletons — a second system would observe its own empty
// telemetry while the FIRST system's serializer does the work.
const SHARED_COPY_SYS = createSelectionCopySystem({
  prototypes: { Text: Tui.Text.prototype, Markdown: Tui.Markdown.prototype, Box: Tui.Box.prototype, Container: Tui.Container.prototype },
  fns: {
    visibleWidth: Tui.visibleWidth,
    sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences,
    wrapTextWithAnsi: Tui.wrapTextWithAnsi,
    renderLatex: (text, options) => Tui.renderLatex(text, options) ?? null,
  },
}, undefined);
SHARED_COPY_SYS.wrapPrototypes();
function makeCopySys() {
  return SHARED_COPY_SYS;
}

test("selection copy stays exact through the margin frame", (t) => {
  const sys = makeCopySys();
  const { tui } = makeAltScreen(60);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  margin.installOnTui(tui);
  const text = "这是一个很长的中文段落用来测试软折行复制功能当我们把窗口调窄时中文字符会按宽度折行但复制时应该保持为一行逻辑文本。";
  const root = new Tui.Container();
  root.addChild(new Tui.Markdown(text, 1, 1, theme, undefined, {}));
  tui.setLayoutRoot(root);
  tui.doRender();
  assert.ok(sys.installOnTui(tui), "instance serializer installs on the margin-wrapped tui");
  const screen = screenLines(tui);
  const firstRow = screen.findIndex((line) => line.includes("这是一个很长的"));
  // The wrap point splits "逻辑文本。" across rows at this width — anchor the
  // last row by its final fragment instead.
  const lastRow = screen.findIndex((line) => line.includes("文本。"));
  assert.ok(firstRow >= 0 && lastRow > firstRow, `paragraph wrapped on screen, got ${JSON.stringify(screen.slice(0, 6))}`);
  const startCell = screen[firstRow].indexOf("这") + 1;
  assert.ok(startCell > 2, "content starts past the gutter");
  const endCell = Tui.visibleWidth(screen[lastRow]) + 1;
  tui.handleTerminalInput(sgr(0, startCell, firstRow + 1));
  tui.handleTerminalInput(sgr(32, endCell, lastRow + 1));
  tui.handleTerminalInput(sgr(0, endCell, lastRow + 1, true));
  assert.equal(tui.hasActiveSelection(), true, "geometry selection active");
  const copied = tui.getActiveSelectionText();
  assert.equal(copied, text, `exact logical copy through the offset frame, got ${JSON.stringify(copied)}`);
});

test("selection copy stays exact inside a scrolled, gutter-offset viewport (content-space x anchor)", (t) => {
  const sys = makeCopySys();
  const { tui } = makeAltScreen(60);
  const margin = createFullscreenMargin(MARGIN_HOST, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  margin.installOnTui(tui);
  // Real-UI shape: document inside a ScrollView, dock beside it.
  const doc = new Tui.Container();
  doc.addChild(new Tui.Markdown("填充行用来把转录撑出滚动条 filler line to overflow\n".repeat(40), 1, 1, theme, undefined, {}));
  const text = "SELECT_BEGIN_MARK\n这一段很长的中文回答会在终端宽度下软折行显示成多个屏幕行，复制时应当保持为一行逻辑文本，不添加多余的换行或空格。\nselect alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\nSELECT_END_MARK";
  doc.addChild(new Tui.Markdown(text, 1, 1, theme, undefined, {}));
  const scroll = new Tui.ScrollView(doc, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
  const root = new Tui.VStack([
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: new Tui.Text("dock footer", 0, 0), basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);
  tui.setLayoutRoot(root);
  tui.doRender();
  assert.ok(sys.installOnTui(tui));
  const screen = screenLines(tui);
  const beginRow = screen.findIndex((l) => l.includes("SELECT_BEGIN_MARK"));
  const endRow = screen.findIndex((l) => l.includes("SELECT_END_MARK"));
  assert.ok(beginRow >= 0 && endRow > beginRow, `markers visible, got ${JSON.stringify(screen)}`);
  const pressX = screen[beginRow].indexOf("SELECT_BEGIN_MARK") + 1;
  const endX = screen[endRow].indexOf("SELECT_END_MARK") + "SELECT_END_MARK".length + 1;
  tui.handleTerminalInput(sgr(0, pressX, beginRow + 1));
  tui.handleTerminalInput(sgr(32, endX, endRow + 1));
  tui.handleTerminalInput(sgr(0, endX, endRow + 1, true));
  const copied = tui.getActiveSelectionText();
  assert.equal(sys.diagnostics().telemetry.lastMode, "exact");
  assert.equal(copied, text, `exact copy inside the offset scroll viewport, got ${JSON.stringify(copied)}`);
});
