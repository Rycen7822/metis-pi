import test from "node:test";
import assert from "node:assert/strict";
import * as Tui from "@earendil-works/pi-tui";
import { copyFrame as renderFrame, installCopyPrototypes, select } from "../helpers/ui-fixtures.mjs";

test.beforeEach((t) => installCopyPrototypes(t, undefined, { renderLatex: () => null }));
const theme = {
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  codeBlockIndent: "  ",
  listBullet: (text) => text,
};

test("copy provenance: dropped spaces bridge selected rows, never shift partial columns", () => {
  const sources = ["alpha   beta  gamma  "];
  for (const terminator of ["\x07", "\x1b\\"]) {
    sources.push(`\x1b]8;;https://example.com${terminator}alpha   beta\x1b]8;;${terminator}  gamma  `);
  }
  for (const source of sources) {
    const frame = renderFrame(new Tui.Text(source, 0, 0), 7);
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
  assert.equal(select(frame, 0, 0, () => ({ start: 1, end: 4 })).text, "   ");

  const controls = renderFrame(new Tui.Text("a\x1b[2Kb\x1b]title\x07c\x1b_apc\x1b\\d", 0, 0), 6);
  assert.equal(select(controls).text, "abcd");
  assert.deepEqual(select(controls, 0, 0, () => ({ start: 1, end: 3 })), { text: "bc", mappedRows: 1, nativeRows: 0 });
});

test("copy provenance: list prefixes retain semantic text and continuation decoration", () => {
  const text = "- alpha   beta  gamma\n- two";
  const frame = renderFrame(new Tui.Markdown(text, 1, 0, theme, undefined, {}), 12);
  assert.deepEqual(select(frame), { text, mappedRows: 4, nativeRows: 0 });
  assert.equal(select(frame, 0, 1, (row) => row === 0 ? { start: 6, end: 8 } : { start: 0, end: 5 }).text, "ha   be");
  assert.equal(select(frame, 0, 0, () => ({ start: 1, end: 3 })).text, "- ");
  assert.deepEqual(select(frame, 1, 1, () => ({ start: 1, end: 3 })), { text: "", mappedRows: 0, nativeRows: 0 });
});

test("copy provenance: code indentation is content only after the decoration span", () => {
  const text = "```js\n  alpha   beta\n\nend\n```";
  const frame = renderFrame(new Tui.Markdown(text, 1, 0, theme, undefined, {}), 12);
  assert.deepEqual(select(frame), { text, mappedRows: 5, nativeRows: 0 });
  assert.equal(select(frame, 1, 1, () => ({ start: 1, end: 5 })).text, "  ");
  assert.equal(select(frame, 1, 2, (row) => row === 1 ? { start: 5, end: 10 } : { start: 0, end: 3 }).text, "alpha   be");
});

test("copy provenance: table rows use exact native extraction", () => {
  const frame = renderFrame(new Tui.Markdown("| a | b |\n| - | - |\n| x | y |", 1, 0, theme, undefined, {}), 12);
  assert.deepEqual(select(frame), {
    text: "┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ x │ y │\n└───┴───┘", mappedRows: 0, nativeRows: 5,
  });
});
