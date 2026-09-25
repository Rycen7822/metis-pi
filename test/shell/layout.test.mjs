// Shell layout golden tests: the task-command matrix across widths, physical
// row budgets, ANSI integrity, truncation windows and resize round-trips —
// through the SAME renderShellCall/renderShellResult functions the live
// components call (merged from the former golden.layout + shell.golden pair,
// which asserted the same budgets through a less faithful wrap stub).
import test from "node:test";
import assert from "node:assert/strict";
import { renderShellCall, renderShellResult, OUTPUT_MAX_ROWS, COMMAND_CONTINUATION_MAX_ROWS } from "../../src/shell.ts";
import { sanitizeShellLine } from "../../src/palette.ts";
import { layout } from "../helpers/ui-fixtures.mjs";

const level = { kind: "truecolor" };

const GOLDEN_COMMANDS = [
  "rtk git diff --numstat -- crates/example/src/mod.rs",
  "cd /tmp/project && python3 -m package.prepare --url https://example.test/paper",
  "printf '%s\\n' \"$HOME\"; tail -50 output.txt",
  "grep -n -e '略过' -e '待补' report.md",
  "FOO=1 python3 script.py",
  "for f in a b; do echo \"$f\"; done",
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "python3 - << EOF\nprint(2)\nEOF",
  "python3 - <<-EOF\n  print(3)\n  EOF",
  "bash script.sh 2>&1 | tail -50",
  "cmd a\\ b \"nested 'quoted'\" $(echo sub) \\\n  continued-line",
  "Get-ChildItem -Recurse $env:TEMP | Out-String",
];
const WIDTHS = [1, 2, 5, 10, 20, 40, 80, 120, 160];
const MULTILINE_OUTPUT = Array.from({ length: 100 }, (_, i) => `line-${i} some output`);

const renderOpts = (command, width, output = "", extra = {}) => ({
  row: {
    title: "Ran", isError: false, isPartial: false,
    command, language: command.includes("Get-ChildItem") ? "powershell" : "bash",
    output, expanded: false, expandHint: "ctrl+o to expand", ...extra,
  },
  width, layout, colorLevel: level,
  bullet: "•", titlePainter: (t) => t,
});
function stripAnsi(value) { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""); }
function assertNoHalfAnsi(lines) {
  for (const line of lines) {
    // After stripping, no dangling ESC may survive (mid-sequence cut).
    assert.ok(!/\x1b$/.test(stripAnsi(line)), `dangling ESC in ${JSON.stringify(line)}`);
  }
}

test("golden: every task command renders within physical-row budgets at all widths", () => {
  for (const command of GOLDEN_COMMANDS) {
    for (const width of WIDTHS) {
      const call = renderShellCall(renderOpts(command, width, MULTILINE_OUTPUT.join("\n")));
      const result = renderShellResult(renderOpts(command, width, MULTILINE_OUTPUT.join("\n")));
      assertNoHalfAnsi(call);
      assertNoHalfAnsi(result);
      // Header exactly once, first call row (prefix may shorten below ~10 cols).
      if (width >= 10) assert.equal(stripAnsi(call[0]).startsWith("• Ran "), true, `${command} @${width}`);
      // Command continuation rows are capped (plus at most one hint row).
      const continuation = call.slice(1);
      assert.ok(continuation.length <= COMMAND_CONTINUATION_MAX_ROWS + 1, `${command} @${width} continuation=${continuation.length}`);
      // Output block: at most 5 physical rows including the ellipsis.
      assert.ok(result.length <= OUTPUT_MAX_ROWS, `${command} @${width} output=${result.length}`);
      for (const line of [...call, ...result]) {
        assert.ok(layout.visibleWidth(line) <= width, `${command} @${width} too wide: ${JSON.stringify(stripAnsi(line))}`);
      }
    }
  }
});

test("golden: expanded mode wraps to width and preserves full output", () => {
  const output = MULTILINE_OUTPUT.join("\n");
  const result = renderShellResult(renderOpts(GOLDEN_COMMANDS[0], 60, output, { expanded: true }));
  assert.ok(result.length >= 100, "expanded shows every logical line");
  for (const line of result) {
    assert.ok(layout.visibleWidth(line) <= 60, `expanded too wide: ${JSON.stringify(stripAnsi(line))}`);
  }
  assertNoHalfAnsi(result);
});

test("golden: middle truncation keeps head and tail with a bounded ellipsis", () => {
  const output = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
  const lines = renderShellResult(renderOpts("rtk git diff --numstat -- src/renderers.ts", 80, output));
  const flat = stripAnsi(lines.join("\n"));
  assert.match(flat, /line-0\b/, "head survives");
  assert.match(flat, /line-39\b/, "tail survives");
  assert.match(flat, /… \+\d+ lines \(ctrl\+o to expand\)/);
  // A single extremely long line and URL-heavy JSON stay within budget too.
  const longUrl = "https://example.test/api/v1/projects/alpha/releases/2026-02-17/builds/1234567890/segment-".repeat(6);
  assert.ok(renderShellResult(renderOpts("cat huge.txt", 40, longUrl)).length <= OUTPUT_MAX_ROWS);
  const json = Array.from({ length: 30 }, (_, i) => `  {\"url\": \"${longUrl}\", \"id\": ${i}}`).join("\n");
  const jsonRows = renderShellResult(renderOpts("cat urls.json", 40, json));
  assert.ok(jsonRows.length <= OUTPUT_MAX_ROWS, `json rows=${jsonRows.length}`);
  assert.doesNotMatch(stripAnsi(jsonRows.join("\n")), /\+0 lines/);
});

test("golden: CJK and emoji outputs respect cell width", () => {
  const cjk = renderShellResult(renderOpts("cat 中文.txt", 40, "中文内容测试\nsecond line\n".repeat(6)));
  for (const line of cjk) {
    assert.ok(layout.visibleWidth(line) <= 40, `CJK too wide: ${JSON.stringify(line)}`);
  }
  const emoji = renderShellResult(renderOpts("cat emoji.txt", 40, "🚀🌟💡 done\n".repeat(8)));
  for (const line of emoji) {
    assert.ok(layout.visibleWidth(line) <= 42, `emoji too wide: ${JSON.stringify(line)}`);
  }
});

test("golden: ANSI-styled output keeps styles per row and never splits sequences", () => {
  const dirty = "\x1b[31mERROR:\x1b[0m failed to compile\n\x1b[32mOK:\x1b[0m built\nplain tail\n".repeat(6);
  const lines = renderShellResult(renderOpts("make all", 60, dirty));
  assertNoHalfAnsi(lines);
  // Colors survive into the visible text.
  assert.match(lines[0], /\x1b\[31m/);
});

test("golden: streaming (partial) shows the bounded tail, never the head", () => {
  const result = renderShellResult(renderOpts("npm test", 80, MULTILINE_OUTPUT.join("\n"), { isPartial: true }));
  assert.ok(result.length <= OUTPUT_MAX_ROWS);
  const flat = stripAnsi(result.join("\n"));
  assert.match(flat, /line-99/);
  assert.doesNotMatch(flat, /line-0\b/);
});

test("golden: empty output shows (no output); error output stays expandable", () => {
  const empty = renderShellResult(renderOpts("true", 80, ""));
  assert.match(stripAnsi(empty.join("\n")), /\(no output\)/);
  const error = renderShellResult(renderOpts("false", 80, "Error: something broke\nstack line 1\n", { isError: true }));
  assert.match(stripAnsi(error.join("\n")), /something broke/);
});

test("golden: resize round-trip and expand/fold cycles keep full text reachable", () => {
  const command = GOLDEN_COMMANDS[1];
  const output = MULTILINE_OUTPUT.join("\n");
  for (const w of [40, 120, 20, 160]) {
    const folded = renderShellResult(renderOpts(command, w, output));
    assert.ok(folded.length <= OUTPUT_MAX_ROWS, `folded budget at ${w}`);
    const expanded = renderShellResult(renderOpts(command, w, output, { expanded: true }));
    assert.ok(expanded.length >= 100, `expanded full at ${w}`);
    for (const line of [...folded, ...expanded]) {
      assert.ok(layout.visibleWidth(line) <= w, `width ${w} exceeded`);
    }
  }
});

test("golden: hint uses the host-provided keybinding text", () => {
  const result = renderShellResult(renderOpts("echo hi", 80, MULTILINE_OUTPUT.join("\n"), { expandHint: "ctrl+t to open transcript" }));
  assert.match(stripAnsi(result.join("\n")), /ctrl\+t to open transcript/);
});

// --- cases absorbed from the former shell.golden.test.mjs (unique only) ---

test("output block gutter: first row uses '  └ ', continuation rows use 4 spaces", () => {
  const lines = renderShellResult(renderOpts("echo hi", 80, "alpha\nbeta\ngamma"));
  const out = lines.filter((line) => /alpha|beta|gamma/.test(stripAnsi(line)));
  assert.match(stripAnsi(out[0]), /  └ .*alpha/);
  assert.match(stripAnsi(out[1]), /^ {4}beta/);
  assert.match(stripAnsi(out[2]), /^ {4}gamma/);
});

test("heredoc body renders as a string, not as highlighted commands", () => {
  const lines = renderShellCall(renderOpts("python3 - <<'EOF'\nprint(1)\nEOF", 120));
  assert.ok(lines.length >= 3);
  assert.match(lines[1], /print\(1\)/);
  assert.match(lines[2], /EOF$/);
});

test("shell output control sequences are stripped except safe SGR", () => {
  const dirty = "\x1b]52;c;c2VjcmV0\x07\x1b[31mRED\x1b[0mplain\x1b[2J\x07";
  const clean = sanitizeShellLine(dirty);
  assert.equal(clean, "\x1b[31mRED\x1b[0mplain");
});
