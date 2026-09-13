import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { productFor, publishedRowsOf } from "../src/selection-copy/model.ts";
import { SelectionSerializer } from "../src/selection-copy/serialize.ts";
import { createSelectionCopySystem } from "../src/selection-copy/index.ts";

Core.initTheme("dark", false);
const handlers = new Map();
extension({
  on: (event, handler) => handlers.set(event, handler),
  getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin", path: "<builtin:bash>" } }],
  registerCommand() {}, appendEntry() {}, registerEntryRenderer() {},
});
handlers.get("session_start")({}, { hasUI: true, ui: { notify(message) { throw new Error(message); } } });

const payload = (text) => ({ content: [{ type: "text", text }], isError: false });
const plain = (rows) => stripVTControlCharacters(rows.join("\n"));
function shell(text = "first\nlast") {
  const row = new Core.ToolExecutionComponent("bash", "scroll-test", { command: "printf old" },
    { showImages: false }, Core.createBashToolDefinition(process.cwd()), { requestRender() {} }, process.cwd());
  row.markExecutionStarted();
  row.updateResult(payload(text));
  row.render(80); // Activate the adapter's deferred self-shell path.
  return row;
}

test("settled shell scroll frames render each leaf once and reuse its copy product", () => {
  const chat = new Tui.Container();
  const rows = Array.from({ length: 8 }, (_, i) => shell(`command ${i}\n${"long output words ".repeat(300)}\nlast`));
  for (const row of rows) chat.addChild(row);
  const tui = new Tui.TuiAltScreen({ columns: 80, rows: 12, write() {} });
  tui.requestRender = () => {};
  tui.beforeTerminalStart();
  tui.setLayoutRoot(new Tui.ScrollView(chat, { primary: true, follow: "end" }));
  tui.doRender();
  const observations = [];
  for (const row of rows) {
    for (const leaf of [row.callRendererComponent, row.resultRendererComponent]) {
      const original = leaf.render.bind(leaf);
      const rendered = original(80);
      const product = productFor(rendered);
      assert.ok(product);
      const observation = { calls: 0 };
      leaf.render = (width) => {
        observation.calls++;
        const next = original(width);
        assert.equal(next, rendered, "scrolling must not rebuild the completed output");
        assert.equal(productFor(next), product, "cached arrays retain their exact copy product");
        return next;
      };
      observations.push(observation);
    }
  }
  const beforeScroll = tui.currentLayout.root.scrollView.scrollTop;
  for (let i = 0; i < 3; i++) {
    tui.handleViewportInput("\x1b[<64;10;5M");
    tui.doRender();
  }
  assert.ok(tui.currentLayout.root.scrollView.scrollTop < beforeScroll);
  for (const { calls } of observations) assert.equal(calls, 3, "one leaf render per wheel frame, including offscreen rows");
  for (const row of rows) assert.ok(publishedRowsOf(row), "self-shell publishes the host's actual rows");
});

test("shell cache follows width, invalidation, streamed updates and expansion without changing old frames", () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i}: ${"words ".repeat(16)}`).join("\n");
  const row = shell(output);
  const call = row.callRendererComponent;
  const result = row.resultRendererComponent;
  const oldRows = result.render(80);
  const oldSnapshot = [...oldRows];
  const oldProduct = productFor(oldRows);
  for (const leaf of [call, result]) {
    const wide = leaf.render(80);
    const narrow = leaf.render(40);
    assert.notEqual(narrow, wide);
    assert.ok(narrow.every((line) => Tui.visibleWidth(line) <= 40));
    assert.equal(leaf.render(40), narrow);
    leaf.invalidate();
    const rebuilt = leaf.render(40);
    assert.notEqual(rebuilt, narrow);
    assert.deepEqual(rebuilt, narrow);
    assert.ok(productFor(rebuilt));
  }
  row.setExpanded(true);
  row.render(80);
  assert.notEqual(row.resultRendererComponent, result);
  assert.match(plain(row.resultRendererComponent.render(80)), /line 10:/);
  row.setExpanded(false);
  row.render(80);
  assert.doesNotMatch(plain(row.resultRendererComponent.render(80)), /line 10:/);
  row.updateArgs({ command: "printf new" });
  assert.match(plain(row.render(80)), /printf new/);
  row.updateResult(payload("stream tail one"), true);
  assert.match(plain(row.render(80)), /stream tail one/);
  row.updateResult(payload("stream tail two"), true);
  assert.match(plain(row.render(80)), /stream tail two/);
  assert.doesNotMatch(plain(row.render(80)), /stream tail one/);
  row.updateResult(payload("finished"), false);
  assert.match(plain(row.render(80)), /Ran printf new[\s\S]*finished/);
  const beforeThemeChange = row.callRendererComponent;
  try {
    Core.initTheme("light", false);
    row.invalidate();
    row.render(80);
    assert.notEqual(row.callRendererComponent, beforeThemeChange);
  } finally {
    Core.initTheme("dark", false);
  }
  assert.deepEqual(oldRows, oldSnapshot, "cached rows from a committed frame never mutate");
  assert.equal(productFor(oldRows), oldProduct);
});

test("MouseRegion preserves logical copy through warm cached shell frames", () => {
  const text = "甲乙丙丁".repeat(30);
  const row = shell(text);
  row.setExpanded(true);
  row.render(40);
  const result = row.resultRendererComponent;
  const region = new Tui.MouseRegion(result, () => undefined);
  const content = new Tui.Container();
  content.addChild(region);
  const tui = new Tui.TuiAltScreen({ columns: 40, rows: 8, write() {} });
  tui.requestRender = () => {};
  tui.beforeTerminalStart();
  tui.setLayoutRoot(new Tui.ScrollView(content, { primary: true, follow: "end" }));
  const serializer = new SelectionSerializer({ visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences });
  for (let i = 0; i < 2; i++) {
    tui.doRender();
    const box = tui.currentLayout.root;
    const lines = box.scrollContentLines;
    const copied = serializer.serialize(tui.currentLayout, {
      scrollView: box.scrollView, startRow: 0, endRow: lines.length - 1, sourceLines: lines,
      columnsFor: (r) => ({ start: 0, end: Tui.visibleWidth(lines[r]) }),
    });
    assert.equal(copied.text, text, "soft wraps join and display gutters stay out of copy");
    assert.equal(copied.nativeRows, 0);
    assert.equal(publishedRowsOf(region), result.render(40));
  }
});

test("repeated selection-copy setup does not stack render wrappers", () => {
  const prototypes = Object.fromEntries(["Text", "Markdown", "Container", "Box", "MouseRegion"].map((key) => [key, Tui[key].prototype]));
  const before = Object.values(prototypes).map((p) => p.render);
  const system = createSelectionCopySystem({ prototypes, fns: {
    visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences, wrapTextWithAnsi: Tui.wrapTextWithAnsi,
  } });
  system.wrapPrototypes();
  system.wrapPrototypes();
  assert.deepEqual(Object.values(prototypes).map((p) => p.render), before);
  const nonExtensible = Object.fromEntries(Object.keys(prototypes).map((key) => [key, Object.preventExtensions({ render() { return []; } })]));
  const original = Object.values(nonExtensible).map((p) => p.render);
  const blocked = createSelectionCopySystem({ prototypes: nonExtensible, fns: {
    visibleWidth: Tui.visibleWidth, sliceByColumn: Tui.sliceByColumn,
    stripTerminalSequences: Tui.stripTerminalSequences, wrapTextWithAnsi: Tui.wrapTextWithAnsi,
  } });
  assert.equal(blocked.wrapPrototypes().installed, false);
  assert.deepEqual(Object.values(nonExtensible).map((p) => p.render), original, "non-extensible prototypes are unchanged");
});
