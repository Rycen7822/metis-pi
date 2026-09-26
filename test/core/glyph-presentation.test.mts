import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGlyphPresenter, createGlyphPresentation } from "../../src/glyph-presentation.ts";

const mark = "✖";
const textSelector = "\ufe0e";
const textMark = `${mark}${textSelector}`;

test("glyph presentation changes content marks only, preserving exact bytes and terminal width", () => {
  const presenter = createGlyphPresenter();
  for (const [source, expected] of [
    ["plain 汉字 └─ │ 🎉\u0000\u0007", "plain 汉字 └─ │ 🎉\u0000\u0007"],
    ["✔ ✖ ✓ ✗ ⚠", "✔\ufe0e ✖\ufe0e ✓\ufe0e ✗\ufe0e ⚠\ufe0e"],
    [`grep -n "${mark}\\|peek:"`, `grep -n "${textMark}\\|peek:"`],
    [`🎉${mark}${mark}🎉`, `🎉${textMark}${textMark}🎉`],
    [`${textMark} ${mark}\ufe0f`, `${textMark} ${mark}\ufe0f`],
    [`\x1b[33m${mark}\x1b[0m`, `\x1b[33m${textMark}\x1b[0m`],
    [`\x1b]8;;https://x/${mark}\x07${mark}\x1b]8;;\x07`, `\x1b]8;;https://x/${mark}\x07${textMark}\x1b]8;;\x07`],
    [`\x1b]8;;https://x/${mark}\x1b\\${mark}`, `\x1b]8;;https://x/${mark}\x1b\\${textMark}`],
    [`\x1b]52;c;YWJj${mark}\x07`, `\x1b]52;c;YWJj${mark}\x07`],
    [`\x1bP${mark}\x1b\\${mark}`, `\x1bP${mark}\x1b\\${textMark}`],
    [`row ${mark}\x1b[3`, `row ${textMark}\x1b[3`],
    [`\x1b7${mark}`, `\x1b7${textMark}`],
    ["", ""],
  ]) {
    const actual = presenter.present(source);
    assert.equal(actual, expected, JSON.stringify(source));
    assert.equal(visibleWidth(actual), visibleWidth(source), "selectors cannot shift later terminal cells");
  }
});

test("one terminal prototype installation transforms text frames and preserves binary writes", () => {
  const written: unknown[] = [];
  class Terminal {
    write(data: unknown) { written.push(data); }
  }
  const terminal = new Terminal();
  const system = createGlyphPresentation({ enabled: true });
  assert.equal(system.installOnTui({ terminal }), true);
  assert.equal(system.installOnTui({ terminal }), true);
  terminal.write(`frame ${mark} peek\n`);
  terminal.write("plain\n");
  terminal.write(Buffer.from("binary\0frame"));
  new Terminal().write("✔!");
  assert.deepEqual(written, [`frame ${textMark} peek\n`, "plain\n", Buffer.from("binary\0frame"), "✔\ufe0e!"]);
});
