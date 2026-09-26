// Real Markdown/Text mirror parity, foreign serializer ownership and logical selection.
import test from "node:test";
import assert from "node:assert/strict";

import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem, detectExternalSerializerPatch } from "../../src/selection-copy/index.ts";
import { altScreen, copyFrame, installCopyPrototypes, markdownTheme, screenLines, select } from "../helpers/ui-fixtures.mjs";

const theme = {
  ...markdownTheme,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  italic: (t) => `\x1b[3m${t}\x1b[23m`,
  underline: (t) => `\x1b[4m${t}\x1b[24m`,
  strikethrough: (t) => `\x1b[9m${t}\x1b[29m`,
};

test("real Markdown copies prose, formatted blocks and hard breaks without mirror degradation", (t) => {
  const sys = installCopyPrototypes(t);
  // Code fences, table fallback and partial list selection have exact oracles in copy-text.
  const cases = [
    ["soft-wrapped prose", 40,
      "alpha beta中文词语\nsee https://example.com/very/long/path/that/exceeds/the/terminal/width for details\n\ngamma"],
    ["formatted blocks", 24,
      "# Heading\n\n> a **bold** and *italic* `code` ~~struck~~ statement\n> next line\n\n- parent\n  - nested\n\n3. ordered",
      "Heading\n\n│ a bold and italic code struck statement\nnext line\n\n- parent\n    - nested\n\n3. ordered"],
    ["hard breaks", 24, "first line  \nsecond line after a hard break\\\nthird line",
      "first line\nsecond line after a hard break\nthird line"],
  ];
  for (const [name, width, text, expected = text] of cases) {
    const frame = copyFrame(new Tui.Markdown(text, 1, 1, theme, undefined, {}), width);
    const result = select(frame, 1, frame.root.lines.length - 2);
    assert.equal(result.text, expected, name);
    assert.equal(result.nativeRows, 0, `${name}: provenance owns every selected content row`);
    const { markdownDegraded, lastDegradedReason } = sys.diagnostics().mirrors;
    assert.equal(markdownDegraded, 0, `${name}: ${lastDegradedReason}`);
  }
});

test("exact card copy omits background and bypasses a foreign serializer wrapper", (t) => {
  const text = "一行中文软折行复制测试内容需要足够长才能在窄宽度下折行成多行屏幕显示验证精确复制。";
  const sys = installCopyPrototypes(t);
  const { tui } = altScreen(60);
  const box = new Tui.Box(1, 1, (line) => `\x1b[48;2;41;41;41m${line}\x1b[49m`);
  box.addChild(new Tui.Markdown(text, 0, 0, theme));
  tui.setLayoutRoot(box);
  tui.doRender();
  assert.ok(sys.installOnTui(tui));
  assert.ok(tui.previousScreen.some((line) => line.includes("\x1b[48;2;41;41;41m")));
  // Simulate the old plugin: wrap the PROTOTYPE method with a heuristic
  // normalizer (adds markers around every newline it sees).
  const proto = Object.getPrototypeOf(tui);
  const original = proto.getActiveSelectionText;
  t.after(() => { proto.getActiveSelectionText = original; });
  proto.getActiveSelectionText = function (...args) {
    const value = original.apply(this, args);
    return value === undefined ? undefined : value.split("\n").join("<<HEURISTIC>>");
  };
  // The test wrapper is an unknown foreign owner (the real plugin names
  // itself via its normalizer source); both must be detected as foreign.
  assert.ok(detectExternalSerializerPatch(proto) !== undefined, "foreign wrapper detected");
  const screen = screenLines(tui);
  const first = screen.findIndex((line) => line.includes("一行中文"));
  const last = screen.findIndex((line) => line.includes("精确复制"));
  assert.ok(first >= 0 && last > first, "wrapped rows present");
  tui.selectionAnchor = { row: first, col: 0, scrollView: undefined, boundary: false };
  tui.selectionFocus = { row: last, col: Tui.visibleWidth(screen[last]), scrollView: undefined, boundary: false };
  const copied = tui.getActiveSelectionText();
  assert.ok(!copied.includes("<<HEURISTIC>>"), "instance replacement bypasses the prototype wrapper");
  assert.equal(copied, text, "exact text despite foreign prototype wrapper");
});

// Prototype wrappers are process-owned; disposing a session only releases its instance resources.
test("repeated selection-copy setup does not stack render wrappers", (t) => {
  const names = ["Text", "Markdown", "Container", "Box", "MouseRegion"];
  const system = installCopyPrototypes(t, names);
  const installed = names.map((name) => Tui[name].prototype.render);
  assert.equal(system.wrapPrototypes().installed, true);
  assert.deepEqual(names.map((name) => Tui[name].prototype.render), installed);

  const sibling = installCopyPrototypes(t, names);
  system.dispose();
  const retained = sibling.wrapPrototypes();
  assert.equal(retained.installed, true, "a later session adopts the process-owned wrappers");
  assert.match(retained.details, /markdown=self/, "self-owned entries are not blocked");
  assert.deepEqual(names.map((name) => Tui[name].prototype.render), installed);
  assert.equal(select(copyFrame(new Tui.Text("still copyable", 0, 0), 40)).text, "still copyable");

  const sealed = Object.fromEntries(names.map((name) => [name, Object.preventExtensions({ render() { return []; } })]));
  const original = Object.values(sealed).map((prototype) => prototype.render);
  const blocked = createSelectionCopySystem({ prototypes: sealed, fns: Tui });
  t.after(() => blocked.dispose());
  assert.equal(blocked.wrapPrototypes().installed, false);
  assert.deepEqual(Object.values(sealed).map((prototype) => prototype.render), original, "sealed prototypes stay unchanged");
});
