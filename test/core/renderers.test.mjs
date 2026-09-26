import test from "node:test";
import assert from "node:assert/strict";
import { formatCall, formatResult, makeRenderers, parseDisplayDiff, renderDiffLines } from "../../src/renderers.ts";
import { theme, FakeText, deepFreeze, sessionStub } from "../helpers.mjs";
import { layout } from "../helpers/layout.mjs";

const result = (text) => ({ content: [{ type: "text", text }] });

test("completion and error labels do not rely on mutating shared renderer state", () => {
  const args = deepFreeze({ command: "printf hello" });
  assert.match(formatCall("bash", args, theme, { isPartial: true }), /• Running printf hello/);
  assert.match(formatCall("bash", args, theme, { isPartial: false }), /• Ran printf hello/);
  assert.match(formatCall("bash", args, theme, { isError: true, isPartial: false }), /• Ran/);
});

test("failure output is visible even when collapsed", () => {
  const text = formatResult("write", result("permission denied"), {}, theme, { isError: true });
  assert.match(text, /permission denied/);
  assert.match(formatResult("edit", result(""), {}, theme, { isError: true }), /Tool failed/);
  // Multiple text blocks all survive formatting.
  const multi = formatResult("read", { content: [{ type: "text", text: "ONE" }, { type: "text", text: "TWO" }] }, { expanded: true }, theme, {});
  assert.match(multi, /ONE/);
  assert.match(multi, /TWO/);
});

test("edit diffs use line-number-first Codex ordering and are not arbitrarily truncated", () => {
  const diff = [
    "  2029 ",
    "- 2030 old value",
    "+ 2030 new value",
    ...Array.from({ length: 30 }, (_, i) => `  ${2031 + i} context-${i}`),
  ].join("\n");
  const input = { content: [], details: { diff } };
  const text = formatResult("edit", input, {}, theme, {});
  assert.match(text, /2030 -old value/);
  assert.match(text, /2030 \+new value/);
  assert.match(text, /2060  context-29/);
  assert.doesNotMatch(text, /more lines|expand tool output/);
});

test("one mixed Pi diff preserves numbers, indentation, Unicode and unnumbered rows", () => {
  const source = "-  4   123 value\n+   4 \t123 value\n   40 13 context\n+ 161 \n-1000 old\n     ...\n+ 8 中文 🚀  \n+    unnumbered\n- ";
  const rows = parseDisplayDiff(source);
  assert.deepEqual(rows.map(({ kind, oldNumber, newNumber, lineNumber, content }) =>
    [kind, oldNumber, newNumber, lineNumber, content]), [
    ["remove", 4, undefined, 4, "  123 value"],
    ["add", undefined, 4, 4, "    123 value"],
    ["context", undefined, 40, 40, "13 context"],
    ["add", undefined, 161, 161, ""],
    ["remove", 1000, undefined, 1000, "old"],
    ["separator", undefined, undefined, undefined, "…"],
    ["add", undefined, 8, 8, "中文 🚀  "],
    ["add", undefined, undefined, undefined, "   unnumbered"],
    ["remove", undefined, undefined, undefined, ""],
  ]);
});

test("a 12-cell diff has literal hanging rows and complete add/remove backgrounds", () => {
  const rows = parseDisplayDiff("  124 \n- 125 1234567890\n+ 125 abcdefghij\n+ 126 \n  127 ");
  const rendered = renderDiffLines({ rows, width: 12, layout, colorLevel: { kind: "truecolor" }, expanded: false, expandHint: "expand" });
  const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  // Three-digit numbers make a seven-cell gutter, leaving five content cells.
  assert.deepEqual(rendered.map(strip), [
    "  124", "  125 -12345", "       67890",
    "  125 +abcde", "       fghij", "  126 +     ", "  127",
  ]);
  for (const [group, rgb] of [[rendered.slice(1, 3), "74;34;29"], [rendered.slice(3, 6), "33;58;43"]]) {
    for (const row of group) {
      assert.ok(row.startsWith(`\x1b[48;2;${rgb}m`));
      assert.ok(row.endsWith("\x1b[49m"), "even a blank added row closes its background");
      assert.equal(layout.visibleWidth(row), 12);
    }
  }
});

test("image preview setting is respected and data never appears in text", () => {
  const input = deepFreeze({ content: [{ type: "image", data: "DO-NOT-PRINT", mimeType: "image/png" }] });
  const off = formatResult("read", input, {}, theme, { showImages: false });
  assert.match(off, /1 image \(TUI preview disabled\)/);
  assert.doesNotMatch(off, /DO-NOT-PRINT/);
  assert.match(formatResult("read", input, {}, theme, { showImages: true }), /1 image/);
});

test("owned renderer components reuse safely and refresh diff counts without host mutation", () => {
  const r = makeRenderers((text) => new FakeText(text), () => "expand", undefined, undefined, undefined, sessionStub);
  const foreign = { setText() { throw new Error("foreign component mutated"); }, render() { return ["foreign"]; } };
  const first = r.read.renderCall({ path: "a.ts" }, theme, { lastComponent: foreign });
  assert.notEqual(first, foreign);
  const second = r.read.renderCall({ path: "b.ts" }, theme, { lastComponent: first });
  assert.equal(first, second);
  assert.match(second.render(80).join("\n"), /b\.ts/);

  const ctx = deepFreeze({ args: { path: "src/a.ts" }, state: {}, isPartial: false });
  const call = r.edit.renderCall(ctx.args, theme, ctx);
  r.edit.renderResult(deepFreeze({ content: [], details: { diff: " 1 context\n-2 old\n+2 new\n+3 added" } }), {}, theme, ctx);
  assert.match(call.render(80).join("\n"), /• Edited src\/a\.ts \(\+2 -1\)/);
  assert.deepEqual(ctx.state, {});
});

test("successful exploration content folds by default, errors and full expansion do not", () => {
  assert.deepEqual(formatCall("read", { path: "README.md" }, theme, { isPartial: false, colorLevel: { kind: "truecolor" } }).split("\n"), [
    "• Explored",
    "\x1B[38;2;108;112;134m  └ \x1B[39m\x1B[38;2;58;150;221mRead\x1B[39m README.md",
  ], "the completed read owns the two-line color format");
  for (const name of ["read", "grep", "find", "ls"]) {
    assert.equal(formatResult(name, result("evidence"), { isPartial: false }, theme, {}), "");
    assert.match(formatResult(name, result("evidence"), { expanded: true }, theme, {}), /evidence/);
    assert.match(formatResult(name, result("error details"), {}, theme, { isError: true }), /error details/);
  }
});

test("written content is previewed without claiming an unknown old-file deletion count", () => {
  const ctx = deepFreeze({ args: { path: "a.ts", content: "alpha\nbeta\n" }, isPartial: false });
  assert.match(formatResult("write", result("wrote file"), {}, theme, ctx), /Written content \(2 lines\)/);
  assert.doesNotMatch(formatCall("write", ctx.args, theme, ctx), /-0/);
});

test("syntax highlighting failures fall back without suppressing the command", () => {
  const paint = () => { throw new Error("unsupported language"); };
  assert.match(formatCall("bash", { command: "echo hello" }, theme, { isPartial: false }, undefined, paint), /echo hello/);
  // Native PowerShell commands receive the same compact execution view.
  assert.match(formatCall("powershell", { command: "Get-Location" }, theme, { isPartial: false }), /• Ran Get-Location/);
});
