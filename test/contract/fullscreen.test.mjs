// Fullscreen contracts own gutters, native hit geometry and layout leases.
import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { createFullscreenLayout, FULLSCREEN_MARGIN_OWNER } from "../../src/chrome/fullscreen-layout.ts";
import { sgr } from "../helpers.mjs";
import { altScreen, container, screenLines } from "../helpers/ui-fixtures.mjs";

test("auto scrollbar keeps colored history inside both gutters on wheel input and resize", (t) => {
  const { tui, terminal } = altScreen(60);
  const layout = createFullscreenLayout(Tui, { margin: 2, minWidth: 40 });
  t.after(() => layout.dispose());
  layout.installOnTui(tui);
  const colors = ["\x1b[48;2;32;55;40m", "\x1b[48;2;70;30;28m"];
  const source = container({ render: (width) => Array.from({ length: 6000 }, (_, i) =>
    `${colors[i % 2]}${`diff ${i}`.padEnd(width)}\x1b[49m`) });
  const scroll = new Tui.ScrollView(source, { primary: true, follow: "end", scrollbar: "auto" });
  tui.setLayoutRoot(scroll);
  assert.equal(layout.status().history.installed, true, "exercise both layout features together");
  t.after(() => scroll.hideTransientScrollbar());
  const checkFrame = () => {
    tui.doRender();
    const diffLines = tui.previousScreen.filter((line) => line.includes("diff "));
    assert.ok(diffLines.length > 1, "colored history remains visible");
    for (const line of diffLines) {
      // Literal reset boundaries prove that even the blank gutter cells are unpainted.
      const ansi = line.replaceAll("\x1b]8;;\x07", "");
      assert.equal(Tui.visibleWidth(line), terminal.columns);
      assert.match(ansi, /^\x1b\[0m  \x1b\[0m\x1b\[48;2;(?:32;55;40|70;30;28)mdiff /);
      assert.match(ansi, /\x1b\[0m  (?:\x1b\[0m)+$/, "right gutter starts after a reset");
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

test("fullscreen leases restore native resources and preserve a later wrapper across reacquisition", (t) => {
  const unopened = createFullscreenLayout({}, { margin: 0, minWidth: 0 });
  assert.doesNotThrow(() => { unopened.dispose(); unopened.dispose(); });
  const { tui } = altScreen(60);
  const nativeListeners = new Set(tui.inputListeners);
  const proto = Object.getPrototypeOf(tui);
  const nativeSet = proto.setLayoutRoot;
  const source = container(new Tui.Text("history", 0, 0));
  const scroll = new Tui.ScrollView(source, { primary: true });
  const wheel = scroll.scrollBy;
  tui.setLayoutRoot(scroll);
  const layout = createFullscreenLayout(Tui, { margin: 2, minWidth: 40 });
  t.after(() => { layout.dispose(); proto.setLayoutRoot = nativeSet; });
  assert.equal(layout.installOnTui({ mode: "regular" }), false);

  // A disposed owner can acquire another lease without stacking hooks or listeners.
  for (let generation = 0; generation < 2; generation++) {
    layout.installOnTui(tui);
    const ownedSetter = proto.setLayoutRoot;
    layout.installOnTui(tui);
    assert.equal(proto.setLayoutRoot, ownedSetter, "retries retain the same hook");
    assert.equal(tui.inputListeners.size, nativeListeners.size + 1);
    layout.dispose();
    assert.equal(proto.setLayoutRoot, nativeSet);
    assert.equal(tui.layoutRoot, scroll);
    assert.equal(scroll.child, source);
    assert.equal(scroll.scrollBy, wheel);
    assert.deepEqual(tui.inputListeners, nativeListeners);
  }

  // A later extension captures our hook. Old generations must remain inert after reuse.
  layout.installOnTui(tui);
  tui.setLayoutRoot(scroll);
  const captured = proto.setLayoutRoot;
  let foreignCalls = 0;
  const foreign = function (root) { foreignCalls++; return captured.call(this, root); };
  proto.setLayoutRoot = foreign;
  layout.installOnTui(tui);
  assert.equal(proto.setLayoutRoot, foreign);
  layout.dispose();
  assert.equal(proto.setLayoutRoot, foreign, "do not overwrite the later owner");
  assert.equal(tui.layoutRoot, scroll);
  assert.equal(scroll.child, source);
  assert.deepEqual(tui.inputListeners, nativeListeners);
  tui.setLayoutRoot(scroll);
  assert.equal(tui.layoutRoot, scroll, "captured hook remains inert");
  assert.equal(scroll.child, source);
  layout.installOnTui(tui);
  assert.equal(tui.inputListeners.size, nativeListeners.size + 1, "only the fresh lease mounts a window");
  assert.equal(tui.layoutRoot[FULLSCREEN_MARGIN_OWNER], scroll);
  layout.dispose();
  assert.equal(proto.setLayoutRoot, foreign);
  assert.equal(tui.layoutRoot, scroll);
  assert.equal(scroll.child, source);
  assert.deepEqual(tui.inputListeners, nativeListeners);
  assert.ok(foreignCalls >= 3, "root restoration honors the foreign setter");
});

test("margin resize preserves native hit geometry, ignores gutter clicks and restores the root", (t) => {
  const { tui, terminal } = altScreen(60);
  const margin = createFullscreenLayout(Tui, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  assert.equal(margin.installOnTui(tui), true);
  const clicks = [];
  const region = new Tui.MouseRegion(new Tui.Text("click target row", 0, 0), (event) => {
    clicks.push({ type: event.type, x: event.x, y: event.y, width: event.width });
    return { render: true };
  });
  const root = container(region);
  tui.setLayoutRoot(root);
  assert.equal(tui.layoutRoot[FULLSCREEN_MARGIN_OWNER], root);
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
  terminal.columns = 30;
  tui.doRender();
  assert.equal(screenLines(tui).find((line) => line.includes("click")).indexOf("click"), 0,
    "narrow terminals drop the margin on the same live root");
  terminal.columns = 60;
  tui.doRender();
  margin.dispose();
  assert.equal(tui.layoutRoot, root);
  tui.doRender();
  assert.equal(screenLines(tui).find((line) => line.includes("click")).indexOf("click"), 0,
    "disposal removes the visible margin");
});
