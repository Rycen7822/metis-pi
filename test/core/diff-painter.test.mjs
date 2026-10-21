import test from "node:test";
import assert from "node:assert/strict";
import { createDiffPainter } from "../../src/presentation/components/tool-components.ts";

function palette() {
  return {
    colors: {},
    fg: (token, text) => `\x1b[${token === "syntaxKeyword" ? "35" : "33"}m${text}\x1b[39m`,
    bold: text => text,
  };
}

test("deferred diff grammars render plain text and retry after becoming ready", () => {
  const theme = palette();
  const text = "notes with `code`";
  const colored = `notes with ${theme.fg("syntaxKeyword", "`code`")}`;
  let ready = false;
  const painter = createDiffPainter(source => ready
    ? source ? colored : ""
    : theme.fg("mdCodeBlock", source));

  assert.equal(painter.paint(text, "markdown", theme), text, "a code-block fallback is not diff syntax");
  assert.equal(painter.paint(text, "markdown", theme), text);
  ready = true;
  assert.equal(painter.paint(text, "markdown", theme), colored, "readiness can change without a new palette");
});

test("a genuine syntax token may have the same color as the code-block fallback", () => {
  const theme = palette();
  const text = '"a string"';
  const colored = theme.fg("syntaxString", text);
  assert.equal(colored, theme.fg("mdCodeBlock", text), "exercise an actual color collision");
  let paints = 0;
  const painter = createDiffPainter(source => {
    paints++;
    return source ? theme.fg("syntaxString", source) : "";
  });

  assert.equal(painter.paint(text, "json", theme), colored, "real same-color syntax must survive");
  const beforeHit = paints;
  assert.equal(painter.paint(text, "json", theme), colored);
  assert.equal(paints, beforeHit, "a ready grammar remains cacheable even with a color collision");
});

test("ready diff syntax reuses work and still honors palette, language, session and opaque boundaries", () => {
  const theme = palette();
  let paints = 0;
  const painter = createDiffPainter(source => {
    paints++;
    return theme.fg("syntaxKeyword", source);
  });
  const expected = theme.fg("syntaxKeyword", "const");

  for (let i = 0; i < 20; i++) assert.equal(painter.paint("const", "typescript", theme), expected);
  assert.equal(paints, 1, "cache hits cannot add highlighter/readiness calls");
  theme.colors = {};
  painter.paint("const", "typescript", theme);
  assert.equal(paints, 2, "a native palette revision invalidates syntax");
  painter.paint("const", "javascript", theme);
  assert.equal(paints, 3, "languages cannot share syntax entries");
  painter.clear();
  painter.paint("const", "typescript", theme);
  assert.equal(paints, 4, "session cleanup releases syntax entries");
  const { colors: _colors, ...opaque } = theme;
  for (let i = 0; i < 2; i++) assert.equal(painter.paint("const", "typescript", opaque), expected);
  assert.equal(paints, 6, "opaque painters retain their uncached behavior");
});
