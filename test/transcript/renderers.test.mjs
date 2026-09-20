import test from "node:test";
import assert from "node:assert/strict";
import { formatCall, formatResult, makeRenderers, parseDisplayDiff, renderDiffLines } from "../../src/renderers.ts";
import { theme, FakeText, deepFreeze, sessionStub } from "../helpers.mjs";

const result = (text) => ({ content: [{ type: "text", text }] });
const lines = (n) => Array.from({ length: n }, (_, i) => `LINE-${i}`).join("\n");

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

test("Pi display diff parser keeps line numbers and hunk separators, and never eats content digits or indentation", () => {
  assert.deepEqual(parseDisplayDiff("  9 before\n-10 old\n+10 new\n     ...\n  20 after"), [
    { kind: "context", oldNumber: undefined, newNumber: 9, lineNumber: 9, content: "before" },
    { kind: "remove", oldNumber: 10, newNumber: undefined, lineNumber: 10, content: "old" },
    { kind: "add", oldNumber: undefined, newNumber: 10, lineNumber: 10, content: "new" },
    { kind: "separator", content: "…" },
    { kind: "context", oldNumber: undefined, newNumber: 20, lineNumber: 20, content: "after" },
  ]);
  // Boundary invariants (absorbed from the former diff.parser.test.mjs):
  // digits and indentation inside content are never reinterpreted.
  const cases = [
    ["+ 10 123 value", "newNumber", 10, "123 value"],
    ["+ 10   return x", "newNumber", 10, "  return x"],
    ["- 7 ", "oldNumber", 7, ""],
    ["+ 8 中文 🚀  ", "newNumber", 8, "中文 🚀  "],
    ["  12 13 shared", "newNumber", 12, "13 shared"],
  ];
  for (const [source, numberField, number, content] of cases) {
    const rows = parseDisplayDiff(source);
    assert.equal(rows.length, 1, source);
    assert.equal(rows[0][numberField], number, source);
    assert.equal(rows[0].content, content, source);
  }
});

test("Codex rich diff uses exact dark backgrounds, full-row fill and hanging indentation", () => {
  const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  const layout = {
    visibleWidth: (value) => strip(value).length,
    wrap: (value, width) => value ? Array.from({ length: Math.ceil(value.length / width) }, (_, i) => value.slice(i * width, (i + 1) * width)) : [],
  };
  const rows = parseDisplayDiff("  2029 \n- 2030 1234567890\n+ 2030 abcdefghij\n+ 2031 \n  2032 ");
  const rendered = renderDiffLines({ rows, width: 12, layout, colorLevel: { kind: "truecolor" }, expanded: false, expandHint: "expand" });
  assert.equal(rendered[0], "  2029");
  assert.match(rendered[1], /^\x1b\[48;2;74;34;29m/);
  const firstAdd = rendered.findIndex((line) => /^\x1b\[48;2;(?:33;58;43)m/.test(line));
  assert.equal(firstAdd, 4);
  // A BLANK added row still carries the full-row background (right padding included).
  const blankAdd = rendered.findIndex((line) => /^\x1b\[48;2;33;58;43m/.test(line) && strip(line).trim() === "2031 +");
  assert.ok(blankAdd > firstAdd, "blank add row present with add background");
  assert.match(rendered[blankAdd], /\x1b\[49m$/, "bg reset closes the blank row");
  for (const line of rendered.filter((line) => /^\x1b\[48;2;(?:74;34;29|33;58;43)m/.test(line))) {
    assert.equal(strip(line).length, 12);
  }
  assert.match(strip(rendered[1]), /^  2030 -1234/);
  assert.match(strip(rendered[2]), /^        5678/);
  assert.match(strip(rendered[3]), /^        90/);
  assert.match(strip(rendered[firstAdd]), /^  2030 \+abcd/);
  assert.match(strip(rendered[firstAdd + 1]), /^        efgh/);
  assert.equal(rendered.at(-1), "  2032");
});

test("image preview setting is respected and data never appears in text", () => {
  const input = deepFreeze({ content: [{ type: "image", data: "DO-NOT-PRINT", mimeType: "image/png" }] });
  const off = formatResult("read", input, {}, theme, { showImages: false });
  assert.match(off, /1 image \(TUI preview disabled\)/);
  assert.doesNotMatch(off, /DO-NOT-PRINT/);
  assert.match(formatResult("read", input, {}, theme, { showImages: true }), /1 image/);
});

test("custom components are never reused or mutated", () => {
  const r = makeRenderers((text) => new FakeText(text), () => "expand", undefined, undefined, undefined, sessionStub);
  const foreign = { setText() { throw new Error("foreign component mutated"); }, render() { return ["foreign"]; } };
  const first = r.read.renderCall({ path: "a.ts" }, theme, { lastComponent: foreign });
  assert.notEqual(first, foreign);
  const second = r.read.renderCall({ path: "b.ts" }, theme, { lastComponent: first });
  assert.equal(first, second);
  assert.match(second.render(80).join("\n"), /b\.ts/);
});

test("malformed optional result shapes do not throw", () => {
  for (const value of [null, 1, {}, { content: [null, {}, { type: "text", text: 42 }] }]) {
    assert.doesNotThrow(() => formatResult("read", value, {}, theme, {}));
  }
});

test("successful exploration content folds by default, errors and full expansion do not", () => {
  for (const name of ["read", "grep", "find", "ls"]) {
    assert.equal(formatResult(name, result("evidence"), { isPartial: false }, theme, {}), "");
    assert.match(formatResult(name, result("evidence"), { expanded: true }, theme, {}), /evidence/);
    assert.match(formatResult(name, result("error details"), {}, theme, { isError: true }), /error details/);
  }
});

test("diff counters update an owned call component in the same redraw, without mutating host state", () => {
  const r = makeRenderers((text) => new FakeText(text), () => "expand", undefined, undefined, undefined, sessionStub);
  const ctx = deepFreeze({ args: { path: "src/a.ts" }, state: {}, isPartial: false });
  const call = r.edit.renderCall(ctx.args, theme, ctx);
  r.edit.renderResult(deepFreeze({ content: [], details: { diff: " 1 context\n-2 old\n+2 new\n+3 added" } }), {}, theme, ctx);
  assert.match(call.render(80).join("\n"), /• Edited src\/a\.ts \(\+2 -1\)/);
  assert.deepEqual(ctx.state, {});
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

test("edit renderer delegates only visual diff payload to the optional rich component factory", () => {
  const calls = [];
  const rich = { render: () => ["RICH"] };
  const r = makeRenderers((text) => new FakeText(text), () => "expand", undefined, (input) => {
    calls.push(input);
    return rich;
  });
  const payload = deepFreeze({ content: [{ type: "text", text: "Successfully replaced text" }], details: { diff: "- 8 old\n+ 8 new" } });
  const ctx = deepFreeze({ args: { path: "a.ts" }, state: {}, isPartial: false });
  r.edit.renderCall(ctx.args, theme, ctx);
  const component = r.edit.renderResult(payload, {}, theme, ctx);
  assert.equal(component, rich);
  assert.equal(calls.length, 1);
  // The rich factory receives structured rows (parsed from Pi's display diff).
  assert.deepEqual(calls[0].rows.map((row) => [row.kind, row.lineNumber, row.content]), [
    ["remove", 8, "old"],
    ["add", 8, "new"],
  ]);
  assert.equal(calls[0].filePath, "a.ts");
  assert.equal(payload.content[0].text, "Successfully replaced text");
});
