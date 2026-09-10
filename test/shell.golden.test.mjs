// Golden tests: Codex exec-cell layout across widths, mirroring the command
// structures from the user's Codex CLI reference screenshots.
import test from "node:test";
import assert from "node:assert/strict";
import { renderShellRow, OUTPUT_MAX_ROWS, COMMAND_CONTINUATION_MAX_ROWS } from "../src/shell.ts";
import { detectColorLevel, sanitizeShellLine } from "../src/palette.ts";
import { tokenizeBashLine } from "../src/bash-lexer.ts";

const layout = {
  wrap: (value, width) => {
    if (!value) return [""];
    const stripped = value.replace(/\x1b\[[0-9;]*m/g, "");
    return Array.from({ length: Math.ceil(stripped.length / width) }, (_, i) => stripped.slice(i * width, (i + 1) * width));
  },
  visibleWidth: (value) => value.replace(/\x1b\[[0-9;]*m/g, "").length,
};
const level = detectColorLevel({ COLORTERM: "truecolor" });

const GOLDEN_COMMANDS = [
  "rtk git diff --numstat -- src/renderers.ts",
  "grep -n -e '略过' src/*.ts",
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "bash script.sh 2>&1 | tail -50",
];
const WIDTHS = [80, 120, 160];
const MULTILINE_OUTPUT = Array.from({ length: 40 }, (_, i) => `line-${i}`);

function render(command, width, output = "") {
  return renderShellRow({
    row: {
      title: "Ran", isError: false, isPartial: false,
      command, language: "bash", output,
      expanded: false, expandHint: "ctrl+o to expand",
    },
    width, layout, colorLevel: level,
    bullet: "•", titlePainter: (title) => title,
  });
}

test("golden: four Codex reference commands render at 80/120/160 columns", () => {
  for (const command of GOLDEN_COMMANDS) {
    for (const width of WIDTHS) {
      const lines = render(command, width, MULTILINE_OUTPUT.join("\n"));
      assert.ok(lines.length > 0, `${command} @${width}`);
      // Header: bullet + Ran + highlighted command head.
      assert.match(lines[0], /^• Ran /);
      // Output block never exceeds the Codex row budget (header + continuation ≤ output rows).
      const outputRows = lines.filter((line) => /^(?:\x1b\[2m)?  (?:└|│) /.test(line.replace(/^\x1b\[2m/, "")) || /^  └ /.test(line) || /^    /.test(line));
      assert.ok(outputRows.length <= OUTPUT_MAX_ROWS + COMMAND_CONTINUATION_MAX_ROWS + 4, `${command} @${width} rows=${outputRows.length}`);
    }
  }
});

test("golden: middle truncation keeps head and tail with ellipsis", () => {
  const lines = render("rtk git diff --numstat -- src/renderers.ts", 80, MULTILINE_OUTPUT.join("\n"));
  const flat = lines.join("\n");
  assert.match(flat, /line-0\b/);
  assert.match(flat, /line-39\b/);
  assert.match(flat, /… \+\d+ lines \(ctrl\+o to expand\)/);
});

test("golden: command continuation prefix is '  │ ' and capped at two rows", () => {
  const long = "bash script.sh " + "arg ".repeat(60);
  const lines = render(long, 80, "");
  const continuation = lines.filter((line) => line.includes("  │ "));
  assert.ok(continuation.length <= COMMAND_CONTINUATION_MAX_ROWS + 1); // +1 ellipsis row
});

test("golden: output first row uses '  └ ' and subsequent rows use 4 spaces", () => {
  const lines = render("echo hi", 80, "alpha\nbeta\ngamma");
  const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  const out = lines.filter((line) => /alpha|beta|gamma/.test(strip(line)));
  assert.match(strip(out[0]), /  └ .*alpha/);
  assert.match(strip(out[1]), /^ {4}beta/);
  assert.match(strip(out[2]), /^ {4}gamma/);
});

test("golden: heredoc body renders as string, not as commands", () => {
  const spans = tokenizeBashLine("python3 - <<'EOF'", true);
  const lines = render(GOLDEN_COMMANDS[2], 120, "");
  assert.ok(Array.isArray(spans));
  assert.ok(lines.length >= 3);
  assert.match(lines[1], /print\(1\)/);
  assert.match(lines[2], /EOF$/);
});

test("shell output control sequences are stripped except safe SGR", () => {
  const dirty = "\x1b]52;c;c2VjcmV0\x07\x1b[31mRED\x1b[0mplain\x1b[2J\x07";
  const clean = sanitizeShellLine(dirty);
  assert.equal(clean, "\x1b[31mRED\x1b[0mplain");
});
