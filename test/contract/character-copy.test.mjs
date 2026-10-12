import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { tokenizeBashLine, highlightBashScript } from "../../src/bash-lexer.ts";
import { createDiffComponent, createShellFactories } from "../../src/chrome/tool-components.ts";
import { CodexThinkingClickableComponent, CodexThinkingPeekComponent, CodexThinkingRailComponent, CodexWriteCallComponent } from "../../src/chrome/transcript-components.ts";
import { createThinkingViewControl } from "../../src/thinking-view.ts";
import { createWorkingComponent } from "../../src/chrome/working.ts";
import { copyFrame, installCopyPrototypes, select } from "../helpers/ui-fixtures.mjs";

const layout = { wrap: Tui.wrapTextWithAnsi, visibleWidth: Tui.visibleWidth };
const theme = { fg: (_tone, text) => text, bold: text => text };
const shell = createShellFactories(layout);
test.beforeEach(t => installCopyPrototypes(t, ["Text", "Markdown", "Container", "Box", "MouseRegion"]));

test("Bash escapes preserve original characters through tokens, colors and command copy", () => {
  for (const command of ["echo foo\\ bar", "printf a\\;b", "echo \\$HOME", "echo \\#literal", "echo foo\\", "echo 'foo bar'", "echo plain"]) {
    assert.equal(tokenizeBashLine(command).map(span => span.text).join(""), command);
    for (const colorLevel of [{ kind: "none" }, { kind: "truecolor" }]) {
      assert.equal(Tui.stripTerminalSequences(highlightBashScript([command], colorLevel)[0]), command);
      const component = shell.makeShellCall({ name: "bash", bullet: "•", title: "Ran", args: { command },
        options: { expanded: true }, theme, context: {}, expandHint: "expand", colorLevel });
      assert.equal(select(copyFrame(component, 40)).text, command);
    }
  }
});

test("real shell components copy consumed spaces, ANSI text and Unicode across physical wraps", () => {
  for (const text of ["alpha   beta  gamma  ", "alpha \x1b[31mRED\x1b[0m  omega", "甲é 👩‍👩‍👦  fin", "RED", "first\nsecond"]) {
    const expected = Tui.stripTerminalSequences(text);
    for (const width of [14, 80]) {
      const output = shell.makeShellResult({ name: "bash", args: {}, result: { content: [{ type: "text", text }] },
        options: { expanded: true, isPartial: false }, theme, context: {}, expandHint: "expand", colorLevel: { kind: "truecolor" } });
      // Select the whole physical row, including its blank trailing cells.
      const copied = select(copyFrame(output, width), 0, undefined, () => ({ start: 0, end: width }));
      assert.equal(copied.text, expected);
      assert.equal(copied.nativeRows, 0);
      const command = shell.makeShellCall({ name: "powershell", bullet: "•", title: "Ran", args: { command: text },
        options: { expanded: true }, theme, context: {}, expandHint: "expand", colorLevel: { kind: "truecolor" } });
      assert.equal(select(copyFrame(command, width), 0, undefined, () => ({ start: 0, end: width })).text, expected);
    }
  }
});

test("shell source mapping degrades to the actual visible row when host wrap changes text", () => {
  const factories = createShellFactories({ ...layout, wrap: () => ["HOST TEXT"] });
  const output = factories.makeShellResult({ name: "bash", args: {}, result: { content: [{ type: "text", text: "source" }] },
    options: { expanded: true }, theme, context: {}, expandHint: "expand", colorLevel: { kind: "none" } });
  const copied = select(copyFrame(output, 40));
  assert.equal(copied.text, "HOST TEXT");
  assert.equal(copied.nativeRows, 1);
});

test("actual diff rows preserve grapheme boundaries, cell width and plain exact copy", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const source of ["a😀b", "aéb", "👩‍👩‍👦x", "甲乙丙", "abc"]) {
    for (const width of [7, 8, 80]) {
      const component = createDiffComponent({ rows: [{ kind: "add", lineNumber: 1, content: source }],
        filePath: "sample.ts", paint: text => `\x1b[31m${text}\x1b[39m`,
        expanded: true, expandHint: "expand", colorLevel: { kind: "truecolor" } }, layout);
      const frame = copyFrame(component, width);
      assert.equal(select(frame).text, `+${source}`);
      const boundaries = new Set([...segmenter.segment(source)].map(item => item.index + item.segment.length));
      let consumed = 0;
      for (const row of frame.root.lines) {
        assert.ok(row.isWellFormed());
        assert.ok(Tui.visibleWidth(row) <= width);
        assert.ok(row.includes("\x1b[31m"), "continuations retain the actual highlighter color");
        consumed += Tui.stripTerminalSequences(row).slice(5).trimEnd().length;
        assert.ok(boundaries.has(consumed), "a physical row ends after a whole source grapheme");
      }
      assert.equal(consumed, source.length);
    }
  }
});

test("Working clips colored rows with one prefix and complete ANSI at narrow widths", () => {
  const component = createWorkingComponent({
    getSnapshot: () => ({ active: true, phase: "working", elapsedMs: 0, thinkingMs: 0, thinkingOpen: false, tools: { first: "中文👩‍👩‍👦", count: 1 } }),
    getShow: () => ({ elapsed: false, thought: false, tool: true, tokens: false }),
    getAnimation: () => ({ enabled: false, intervalMs: 64 }), requestRender() {}, colorKind: "truecolor",
    paint: (text, tone) => tone === "accent" ? `\x1b[36m${text}\x1b[39m` : text,
  });
  for (const width of [1, 2, 3, 5, 10, 40, 80]) {
    const [row] = component.render(width);
    assert.ok(Tui.visibleWidth(row) <= width);
    assert.ok(row.isWellFormed());
    const plain = Tui.stripTerminalSequences(row);
    assert.doesNotMatch(plain, /\x1b/);
    assert.ok((plain.match(/•/g) ?? []).length <= 1);
  }
  assert.match(Tui.stripTerminalSequences(component.render(80)[0]), /^• Working .*中文👩‍👩‍👦$/);
  component.dispose();
});

test("Container consumes the rows published by actual transcript leaves without rendering again", t => {
  const text = new Tui.Text("one\ntwo\nthree", 0, 0);
  const render = t.mock.method(text, "render");
  const control = createThinkingViewControl();
  const peek = new CodexThinkingPeekComponent(text, control, 2, value => value, () => {});
  const rail = new CodexThinkingRailComponent(peek, { kind: "none" });
  const clickable = new CodexThinkingClickableComponent(rail, control, "peek", () => {});
  const parent = new Tui.Container();
  parent.addChild(clickable);
  const frame = copyFrame(parent, 40);
  assert.equal(render.mock.callCount(), 1);
  assert.equal(select(frame, 1).text, "two\nthree");
  const leafRender = t.mock.method(clickable, "render");
  parent.render(40);
  assert.equal(leafRender.mock.callCount(), 1, "even a cached child is not asked to render twice");

  const write = new CodexWriteCallComponent({ name: "write", args: {}, stage: "receiving-arguments", contentPrefix: "first\nsecond",
    expanded: true, theme, context: {}, expandHint: "expand", colorLevel: { kind: "none" }, headerText: "Writing sample", layout });
  const writeRender = t.mock.method(write, "render");
  const writes = new Tui.Container();
  writes.addChild(write);
  copyFrame(writes, 40);
  assert.equal(writeRender.mock.callCount(), 1);
});
