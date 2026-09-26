import test from "node:test";
import assert from "node:assert/strict";
import { renderShellCall, renderShellResult } from "../../src/shell.ts";
import { renderWritePreview } from "../../src/write-preview.ts";
import { sanitizeShellLine } from "../../src/palette.ts";
import { layout } from "../helpers/layout.mjs";

// Independent physical budgets, never read from the implementation.
const CALL_ROW_BUDGET = 4;
const OUTPUT_ROW_BUDGET = 5;
const level = { kind: "truecolor" };
const renderOpts = (command, width, output = "", extra = {}) => ({
  row: { title: "Ran", command, language: "bash", output, isError: false,
    isPartial: false, expanded: false, expandHint: "ctrl+t to open", ...extra },
  width, layout, colorLevel: level, bullet: "•", titlePainter: (text) => text,
});
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const content = (row) => row.spans.filter((span) => ["content", "semantic"].includes(span.kind)).map((span) => span.text ?? "").join("");
function assertRowsFit(rows, width, budget = Infinity) {
  assert.ok(rows.length <= budget, `at most ${budget} rows at ${width} columns`);
  for (const row of rows) {
    assert.ok(layout.visibleWidth(row) <= width, `row exceeds ${width}: ${JSON.stringify(row)}`);
    assert.doesNotMatch(row.replace(/\x1b\[[0-9;]*m/g, ""), /\x1b/, "only complete SGR escapes");
  }
}

test("wrapped commands respect the header and four-row physical budget", () => {
  for (const width of [1, 2, 4, 5, 10, 40, 160]) {
    const rows = renderShellCall(renderOpts("printf '%s' 中文 && ".repeat(30), width));
    assertRowsFit(rows, width, CALL_ROW_BUDGET);
    if (width >= 10) assert.ok(plain(rows[0]).startsWith("• Ran "));
  }
});

test("output widths cover missing gutters, wide glyphs and the truncation boundary", () => {
  for (const width of [1, 2, 4, 5, 40]) {
    for (const output of ["", "x", "a\nb", "中文 🚀".repeat(20)]) {
      const copyOut = [];
      const rows = renderShellResult({ ...renderOpts("echo", width, output), copyOut });
      assertRowsFit(rows, width, OUTPUT_ROW_BUDGET);
      if (output === "a\nb") {
        assert.equal(copyOut.length, rows.length);
        assert.deepEqual(copyOut.map(content), ["a", "b"], "narrow gutters never consume content");
        assert.ok(copyOut.every((row) => row.breakBefore === "hard"));
        assert.ok(copyOut.every((row) => row.spans.every((span) => span.colEnd >= span.colStart)));
      }
    }
  }
  for (const count of [4, 5, 6]) {
    const rows = renderShellResult(renderOpts("echo", 40, "line\n".repeat(count).trimEnd()));
    assertRowsFit(rows, 40, OUTPUT_ROW_BUDGET);
    assert.equal(rows.length, Math.min(count, 5));
    assert.doesNotMatch(plain(rows.join("\n")), /\+0 lines/);
  }
});

test("final output keeps both ends, streaming keeps the tail, expansion exposes every line", () => {
  const output = "first\nsecond\nthird\nfourth\nfifth\nlast";
  for (const isPartial of [false, true]) {
    const rows = renderShellResult(renderOpts("echo", 40, output, { isPartial }));
    assertRowsFit(rows, 40, OUTPUT_ROW_BUDGET);
    const text = plain(rows.join("\n"));
    assert.match(text, /last/);
    if (isPartial) assert.doesNotMatch(text, /first/);
    else assert.match(text, /first[\s\S]*… \+\d+ lines \(ctrl\+t to open\)/);
  }
  const expanded = renderShellResult(renderOpts("echo", 40, output, { expanded: true }));
  assertRowsFit(expanded, 40);
  assert.deepEqual(expanded.map(plain), ["  └ first", "    second", "    third", "    fourth", "    fifth", "    last"]);
});

test("empty/error output and safe styling survive the output pipeline", () => {
  assert.match(plain(renderShellResult(renderOpts("true", 40)).join("\n")), /\(no output\)/);
  assert.match(plain(renderShellResult(renderOpts("false", 40, "permission denied", { isError: true })).join("\n")), /permission denied/);
  const dirty = "\x1b]52;c;c2VjcmV0\x07\x1b[31mRED\x1b[0mplain\x1b[2J\x07";
  assert.equal(sanitizeShellLine(dirty), "\x1b[31mRED\x1b[0mplain");
  const rows = renderShellResult(renderOpts("echo", 12, dirty));
  assertRowsFit(rows, 12, OUTPUT_ROW_BUDGET);
  assert.match(rows[0], /\x1b\[31m/);
});

test("shell syntax uses literal Bash colors while PowerShell remains verbatim", () => {
  const quoted = "printf '%s' \"a b\" \\\n  \"$HOME\"";
  for (const [language, command, expected, colored] of [
    ["bash", quoted, ["• Ran printf '%s' \"a b\" \\", "  │   \"$HOME\""], "\u001b[38;2;166;227;161m\"a b\"\u001b[39m"],
    ["bash", "cat <<'EOF'\nprint(1)\nEOF", ["• Ran cat <<'EOF'", "  │ print(1)", "  │ EOF"], "\x1b[38;2;166;227;161mprint(1)\x1b[39m"],
    ["powershell", 'Get-ChildItem "$env:TEMP"', ['• Ran Get-ChildItem "$env:TEMP"'], undefined],
  ]) {
    const rows = renderShellCall(renderOpts(command, 80, "", { language }));
    assert.deepEqual(rows.map(plain), expected);
    if (colored) assert.ok(rows.join("\n").includes(colored), `${language}: string uses its literal color`);
    else assert.deepEqual(rows, expected, "PowerShell bypasses the Bash lexer");
  }
});

test("command cap preserves 1200 characters and a complete ellipsis", () => {
  for (const length of [1199, 1200, 1201]) {
    const rows = renderShellCall(renderOpts("x".repeat(length), 160, "", { expanded: true }));
    const text = plain(rows.join(""));
    assert.equal((text.match(/x/g) ?? []).length, Math.min(length, 1200));
    assert.equal(text.includes("…"), length > 1200);
    assertRowsFit(rows, 160);
  }
});

test("command spans preserve exact hard breaks, long tokens and an unstyled empty header", () => {
  for (const [command, expanded, expected, breaks] of [
    ["python3 - <<'EOF'\nprint(1)\nEOF", false, "python3 - <<'EOF'\nprint(1)\nEOF", ["hard", "hard", "hard"]],
    ["x".repeat(240), true, "x".repeat(240), ["hard", "soft", "soft", "soft", "soft"]],
    ["", false, "• Ran", ["hard"]],
  ]) {
    const copyOut = [];
    const rows = renderShellCall({ ...renderOpts(command, 60, "", { expanded }),
      titlePainter: (title) => `\x1b[1m${title}\x1b[22m`, copyOut });
    assert.equal(copyOut.length, rows.length);
    if (expanded) assert.ok(rows.length > 3);
    assert.equal(copyOut.map(content).join(expanded ? "" : "\n"), expected);
    assert.deepEqual(copyOut.map((row) => row.breakBefore), breaks);
    for (const span of copyOut.flatMap((row) => row.spans)) assert.doesNotMatch(span.text ?? "", /\x1b/);
  }
});

test("streaming copy starts a hard boundary and keeps five soft-wrapped tail rows", () => {
  const copyOut = [];
  const rows = renderShellResult({ ...renderOpts("", 8, "x".repeat(24), { isPartial: true }), copyOut });
  assertRowsFit(rows, 8, OUTPUT_ROW_BUDGET);
  assert.equal(copyOut.length, rows.length);
  // Eight terminal cells minus the four-cell gutter leave four content cells.
  assert.deepEqual(copyOut.map(content), Array(5).fill("xxxx"));
  assert.deepEqual(copyOut.map((row) => row.breakBefore), ["hard", "soft", "soft", "soft", "soft"]);
});

test("write preview excludes its stage decoration and preserves the visible tail boundary", () => {
  const copyOut = [];
  const text = `${"x".repeat(2000)}\nTAIL`;
  const options = { width: 60, stage: "receiving-arguments", theme: { fg: (_role, value) => value },
    colorLevel: level, layout, gutter: "  │ " };
  const rows = renderWritePreview(text, { ...options, expanded: false, copyOut });
  assertRowsFit(rows, 60, 12);
  assert.match(rows[0], /Receiving content · preview, not yet committed/);
  assert.match(rows[0], /\x1b\[2m/);
  assert.doesNotMatch(rows.join("\n"), /Added|Edited|Written/);
  assert.equal(copyOut.length, rows.length);
  assert.equal(content(copyOut[0]), "", "stage text is decoration");
  assert.equal(copyOut[1].breakBefore, "hard");
  assert.ok(copyOut.slice(2).some((row) => row.breakBefore === "soft"));
  assert.match(renderWritePreview(text, { ...options, expanded: true }).join("\n"), /TAIL/);
});
