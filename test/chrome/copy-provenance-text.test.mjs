import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as Tui from "@earendil-works/pi-tui";
import { createSelectionCopySystem } from "../../src/selection-copy/index.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { SelectionSerializer } from "../../src/selection-copy/serialize.ts";

const system = createSelectionCopySystem({
  prototypes: {
    Text: Tui.Text.prototype,
    Markdown: Tui.Markdown.prototype,
    Box: Tui.Box.prototype,
    Container: Tui.Container.prototype,
  },
  fns: { ...Tui, renderLatex: () => null },
});
system.wrapPrototypes();
const serializer = new SelectionSerializer(Tui);
const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  codeBlockIndent: "  ",
  listBullet: (text) => text,
};

test("retained text spans do not keep per-grapheme string ropes", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", "--input-type=module", "-e", String.raw`
    import assert from "node:assert/strict";
    import * as Tui from "@earendil-works/pi-tui";
    import { createSelectionCopySystem } from "./src/selection-copy/index.ts";
    import { productFor } from "./src/selection-copy/model.ts";
    createSelectionCopySystem({
      prototypes: Object.fromEntries(["Text", "Markdown", "Box", "Container"].map((name) => [name, Tui[name].prototype])),
      fns: { ...Tui, renderLatex: () => null },
    }).wrapPrototypes();
    new Tui.Text("warm up ".repeat(30), 0, 0).render(80);
    const input = Array.from({ length: 1200 }, (_, index) => index + ": " + "ascii words 甲乙 ".repeat(12)).join("\n");
    const component = new Tui.Text(input, 0, 0);
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const rows = component.render(80);
    const product = productFor(rows);
    assert.ok(product && product.rows.some((row) => row.spans.some((span) => span.text?.length)));
    assert.equal(rows.length, 3600);
    global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    assert.ok(retained < 6 * 1024 * 1024, "copy scene retained " + retained + " bytes");
    assert.equal(component.render(80), rows);
    assert.equal(productFor(rows), product);
  `], { cwd: new URL("../../", import.meta.url), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

function renderFrame(component, width) {
  const lines = component.render(width);
  assert.ok(productFor(lines), system.diagnostics().mirrors.lastDegradedReason);
  const rect = { x: 0, y: 0, width, height: lines.length };
  return { root: { component, rect, clip: rect, children: [], lines } };
}

function select(frame, startRow = 0, endRow = frame.root.lines.length - 1, columnsFor = () => ({ start: 0, end: frame.root.rect.width })) {
  return serializer.serialize(frame, { scrollView: undefined, startRow, endRow, sourceLines: frame.root.lines, columnsFor });
}

test("copy provenance: dropped spaces bridge selected rows, never shift partial columns", () => {
  const sources = ["alpha   beta  gamma  "];
  for (const terminator of ["\x07", "\x1b\\"]) {
    sources.push(`\x1b]8;;https://example.com${terminator}alpha   beta\x1b]8;;${terminator}  gamma  `);
  }
  for (const source of sources) {
    const frame = renderFrame(new Tui.Text(source, 0, 0), 7);
    assert.deepEqual(productFor(frame.root.lines).rows.map((row) => [row.breakBefore, row.bridge, row.spans[1]]), [
      ["hard", undefined, { colStart: 0, colEnd: 5, kind: "content", text: "alpha" }],
      ["soft", "   ", { colStart: 0, colEnd: 4, kind: "content", text: "beta" }],
      ["soft", "  ", { colStart: 0, colEnd: 7, kind: "content", text: "gamma  " }],
    ]);
    assert.deepEqual(select(frame), { text: "alpha   beta  gamma  ", mappedRows: 3, nativeRows: 0 });
    assert.deepEqual(select(frame, 0, 1, (row) => row === 0 ? { start: 3, end: 5 } : { start: 0, end: 2 }), {
      text: "ha   be", mappedRows: 2, nativeRows: 0,
    });
    assert.equal(select(frame, 1, 1, () => ({ start: 0, end: 2 })).text, "be", "no bridge without the preceding row");
    assert.equal(select(frame, 2, 2, () => ({ start: 5, end: 7 })).text, "  ", "selected trailing spaces are content");
  }
});

test("copy provenance: styled whitespace stays in the row; CJK, combining and emoji columns stay exact", () => {
  // The reset makes the following space token non-whitespace to the host:
  // these spaces survive wrapping and must NOT move into a bridge.
  const frame = renderFrame(new Tui.Text("\x1b[1m你e\u0301 👩‍👩‍👦\x1b[22m  fin", 0, 0), 6);
  assert.deepEqual(productFor(frame.root.lines).rows.map((row) => [row.breakBefore, row.bridge, row.spans[1]]), [
    ["hard", undefined, { colStart: 0, colEnd: 6, kind: "content", text: "你e\u0301 👩‍👩‍👦" }],
    ["soft", "", { colStart: 0, colEnd: 5, kind: "content", text: "  fin" }],
  ]);
  assert.deepEqual(select(frame), { text: "你e\u0301 👩‍👩‍👦  fin", mappedRows: 2, nativeRows: 0 });
  for (const [start, end, expected] of [[0, 2, "你"], [2, 3, "e\u0301"], [4, 6, "👩‍👩‍👦"]]) {
    assert.equal(select(frame, 0, 0, () => ({ start, end })).text, expected);
  }
  assert.equal(select(frame, 1, 1, () => ({ start: 0, end: 2 })).text, "  ");
  assert.equal(select(frame, 0, 1, (row) => row === 0 ? { start: 4, end: 6 } : { start: 0, end: 3 }).text, "👩‍👩‍👦  f");
});

test("copy provenance: hard boundaries, tab expansion and stripped control spans remain distinct", () => {
  const frame = renderFrame(new Tui.Text("a\tb\r\nc\rd\n\n e", 0, 0), 6);
  assert.deepEqual(select(frame), { text: "a   b\nc\nd\n\n e", mappedRows: 4, nativeRows: 0 });
  assert.ok(productFor(frame.root.lines).rows.every((row) => row.breakBefore === "hard" && row.bridge === undefined));
  assert.equal(select(frame, 0, 0, () => ({ start: 1, end: 4 })).text, "   ");

  const controls = renderFrame(new Tui.Text("a\x1b[2Kb\x1b]title\x07c\x1b_apc\x1b\\d", 0, 0), 6);
  assert.deepEqual(productFor(controls.root.lines).rows[0].spans[1], { colStart: 0, colEnd: 4, kind: "content", text: "abcd" });
  assert.deepEqual(select(controls, 0, 0, () => ({ start: 1, end: 3 })), { text: "bc", mappedRows: 1, nativeRows: 0 });
});

test("copy provenance: list prefixes retain semantic text and continuation decoration", () => {
  const text = "- alpha   beta  gamma\n- two";
  const frame = renderFrame(new Tui.Markdown(text, 1, 0, theme, undefined, {}), 12);
  assert.deepEqual(productFor(frame.root.lines).rows.map((row) => row.spans.slice(1, -1)), [
    [{ colStart: 1, colEnd: 3, kind: "semantic", text: "- " }, { colStart: 3, colEnd: 8, kind: "content", text: "alpha" }],
    [{ colStart: 1, colEnd: 3, kind: "decoration", text: "" }, { colStart: 3, colEnd: 7, kind: "content", text: "beta" }],
    [{ colStart: 1, colEnd: 3, kind: "decoration", text: "" }, { colStart: 3, colEnd: 8, kind: "content", text: "gamma" }],
    [{ colStart: 1, colEnd: 3, kind: "semantic", text: "- " }, { colStart: 3, colEnd: 6, kind: "content", text: "two" }],
  ]);
  assert.deepEqual(select(frame), { text, mappedRows: 4, nativeRows: 0 });
  assert.equal(select(frame, 0, 1, (row) => row === 0 ? { start: 6, end: 8 } : { start: 0, end: 5 }).text, "ha   be");
  assert.equal(select(frame, 0, 0, () => ({ start: 1, end: 3 })).text, "- ");
  assert.deepEqual(select(frame, 1, 1, () => ({ start: 1, end: 3 })), { text: "", mappedRows: 0, nativeRows: 0 });
});

test("copy provenance: code indentation is content only after the decoration span", () => {
  const text = "```js\n  alpha   beta\n\nend\n```";
  const frame = renderFrame(new Tui.Markdown(text, 1, 0, theme, undefined, {}), 12);
  assert.deepEqual(productFor(frame.root.lines).rows[1].spans.slice(1, -1), [
    { colStart: 1, colEnd: 3, kind: "decoration", text: "  " },
    { colStart: 3, colEnd: 10, kind: "content", text: "  alpha" },
  ]);
  assert.deepEqual(select(frame), { text, mappedRows: 5, nativeRows: 0 });
  assert.equal(select(frame, 1, 1, () => ({ start: 1, end: 5 })).text, "  ");
  assert.equal(select(frame, 1, 2, (row) => row === 1 ? { start: 5, end: 10 } : { start: 0, end: 3 }).text, "alpha   be");
});

test("copy provenance: unknown table rows still extract natively despite empty span text", () => {
  const frame = renderFrame(new Tui.Markdown("| a | b |\n| - | - |\n| x | y |", 1, 0, theme, undefined, {}), 12);
  assert.ok(productFor(frame.root.lines).rows.every((row) => row.spans[1].kind === "unknown" && row.spans[1].text === ""));
  assert.deepEqual(select(frame), {
    text: "┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ x │ y │\n└───┴───┘", mappedRows: 0, nativeRows: 5,
  });
});
