// copy-provenance.test.mjs — own-renderer (shell/write) copyOut contracts
// against the REAL host wrap primitives:
// - shell command spans are PLAIN text even when syntax highlighting colors
//   the visual segments (the serializer copies span text verbatim);
// - streaming/collapsed tail windows force breakBefore "hard" on the FIRST
//   kept row only — soft joins among kept rows stay intact.
import test from "node:test";
import assert from "node:assert/strict";

import { renderShellCall, renderShellResult, OUTPUT_MAX_ROWS } from "../../src/shell.ts";
import { renderWritePreview } from "../../src/write-preview.ts";
import { detectColorLevel } from "../../src/palette.ts";
import { layout } from "../helpers/ui-fixtures.mjs";

// Host wrap preserves ANSI in its output segments (unlike a plain-text stub),
// so colored renders exercise the real span-text path.
const trueColor = detectColorLevel({ COLORTERM: "truecolor" });
const ANSI = /\x1b/;

const baseRow = (over) => ({
  title: "Ran", isError: false, isPartial: false,
  command: "", output: "", expanded: false, expandHint: "ctrl+o to expand",
  ...over,
});
const baseInput = {
  width: 60,
  layout,
  colorLevel: trueColor,
  bullet: "•",
  titlePainter: (title) => `\x1b[1m${title}\x1b[22m`,
};

function reconstruct(copyOut) {
  const parts = [];
  for (const row of copyOut) {
    const text = row.spans
      .filter((span) => (span.kind === "content" || span.kind === "semantic") && span.text)
      .map((span) => span.text)
      .join("");
    if (!text) continue;
    if (parts.length) parts.push(row.breakBefore === "soft" ? (row.bridge ?? "") : "\n");
    parts.push(text);
  }
  return parts.join("");
}

for (const [name, command, expanded] of [
  ["heredoc", "python3 - <<'EOF'\nprint(1)\nEOF", false],
  ["long wrapped command", `bash deploy.sh ${"--flag value ".repeat(30)}`.trimEnd(), true],
]) {
  test(`shell ${name}: highlighted call copy spans stay plain`, () => {
    const copyOut = [];
    const lines = renderShellCall({ row: baseRow({ command, language: "bash", expanded }), ...baseInput, copyOut });
    assert.equal(copyOut.length, lines.length, "one copy row per visual row");
    if (expanded) assert.ok(lines.length > 3, "command actually wraps");
    for (const span of copyOut.flatMap((row) => row.spans)) {
      if (span.text !== undefined) assert.ok(!ANSI.test(span.text), `ANSI-free: ${JSON.stringify(span.text)}`);
    }
    // Own-renderer soft joins omit consumed wrap spaces; hard heredoc breaks
    // must still round-trip verbatim, including whitespace.
    const normalize = expanded ? (text) => text.replace(/\s+/g, "") : (text) => text;
    assert.equal(normalize(reconstruct(copyOut)), normalize(command));
  });
}

test("shell call header-only copy span is stripped of title styling", () => {
  const copyOut = [];
  renderShellCall({ row: baseRow({ command: "" }), ...baseInput, copyOut });
  assert.equal(copyOut.length, 1);
  const content = copyOut[0].spans.filter((span) => span.kind === "content");
  assert.equal(content.map((span) => span.text).join(""), "• Ran");
});

test("streaming shell result tail forces hard only on the first kept row", () => {
  const copyOut = [];
  // One long logical line wraps to more rows than the streaming window keeps,
  // so the window starts mid-line but most kept rows are soft continuations.
  const output = "x".repeat(56 * (OUTPUT_MAX_ROWS + 5));
  const lines = renderShellResult({ row: baseRow({ output, isPartial: true }), ...baseInput, copyOut });
  assert.equal(copyOut.length, lines.length);
  assert.ok(lines.length <= OUTPUT_MAX_ROWS, "bounded tail window");
  assert.equal(copyOut[0].breakBefore, "hard", "window head is a hard boundary");
  assert.ok(copyOut.slice(1).some((row) => row.breakBefore === "soft"), "soft joins survive inside the window");
  const copied = reconstruct(copyOut);
  assert.ok(!copied.includes("\n"), "soft-wrapped tail copies as one logical line");
  assert.ok(output.endsWith(copied), "copied text is the logical line's tail");
});

test("collapsed write preview forces hard only on the first visible body row", () => {
  const copyOut = [];
  const content = ("wrap me around the preview body ".repeat(4) + "\n").repeat(30);
  const rows = renderWritePreview(content, {
    width: 60,
    stage: "executing",
    expanded: false,
    theme: { fg: (_key, text) => text },
    colorLevel: { kind: "none" },
    layout,
    gutter: "  │ ",
    copyOut,
  });
  assert.equal(copyOut.length, rows.length, "stage row + body rows + optional hint");
  const body = copyOut.slice(1); // copyOut[0] is the stage row (decoration)
  assert.equal(body[0].breakBefore, "hard", "window head is a hard boundary");
  assert.ok(body.some((row) => row.breakBefore === "soft"), "soft wraps survive inside the window");
});
