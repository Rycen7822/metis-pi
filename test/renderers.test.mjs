import test from "node:test";
import assert from "node:assert/strict";
import { formatCall, formatResult, makeRenderers, safeText, parseDisplayDiff, renderCodexDiffLines } from "../src/renderers.ts";
import { theme, FakeText, deepFreeze } from "./helpers.mjs";

const result = (text) => ({ content: [{ type: "text", text }] });
const lines = (n) => Array.from({ length: n }, (_, i) => `LINE-${i}`).join("\n");

test("completion and error labels do not rely on mutating shared renderer state", () => {
  const args = deepFreeze({ command: "printf hello" });
  assert.match(formatCall("bash", args, theme, { isPartial: true }), /• Running printf hello/);
  assert.match(formatCall("bash", args, theme, { isPartial: false }), /• Ran printf hello/);
  assert.match(formatCall("bash", args, theme, { isError: true, isPartial: false }), /• Ran/);
});

test("each file operation retains its own row; there is no cross-call grouping", () => {
  for (const name of ["read", "write", "edit"]) {
    assert.match(formatCall(name, { path: "a.ts" }, theme, {}), /a\.ts/);
    assert.match(formatCall(name, { path: "b.ts" }, theme, {}), /b\.ts/);
  }
});

test("completed bash preview keeps head and tail and preserves exit status text", () => {
  const text = formatResult("bash", result(`${lines(25)}\nexit code: 17`), {}, theme, {}, "my key");
  assert.match(text, /LINE-0\b/);
  assert.match(text, /LINE-24/);
  assert.match(text, /exit code: 17/);
  assert.match(text, /… \+21 lines \(my key\)/);
});

test("expanded output has no 200-line cap", () => {
  const text = formatResult("read", result(lines(900)), { expanded: true }, theme, {});
  for (const i of [0, 199, 500, 899]) assert.match(text, new RegExp(`LINE-${i}\\b`));
  assert.doesNotMatch(text, /more lines/);
});

test("long lines are clipped only in preview", () => {
  const input = `${"x".repeat(2500)}THE-END`;
  assert.match(formatResult("bash", result(input), {}, theme, {}), /line shortened/);
  assert.match(formatResult("read", result(input), { expanded: true }, theme, {}), /THE-END/);
});

test("all text blocks remain readable", () => {
  const input = { content: [{ type: "text", text: "ONE" }, { type: "text", text: "TWO" }] };
  const text = formatResult("read", input, { expanded: true }, theme, {});
  assert.match(text, /ONE/);
  assert.match(text, /TWO/);
});

test("failure output is visible even when collapsed", () => {
  const text = formatResult("write", result("permission denied"), {}, theme, { isError: true });
  assert.match(text, /permission denied/);
  assert.match(formatResult("edit", result(""), {}, theme, { isError: true }), /Tool failed/);
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

test("Pi display diff parser keeps line numbers and hunk separators", () => {
  assert.deepEqual(parseDisplayDiff("  9 before\n-10 old\n+10 new\n     ...\n  20 after"), [
    { kind: "context", oldNumber: undefined, newNumber: 9, lineNumber: 9, content: "before" },
    { kind: "remove", oldNumber: 10, newNumber: undefined, lineNumber: 10, content: "old" },
    { kind: "add", oldNumber: undefined, newNumber: 10, lineNumber: 10, content: "new" },
    { kind: "separator", content: "…" },
    { kind: "context", oldNumber: undefined, newNumber: 20, lineNumber: 20, content: "after" },
  ]);
});

test("Codex rich diff uses exact dark backgrounds, full-row fill and hanging indentation", () => {
  const strip = (value) => value.replace(/\x1b\[[0-9;]*m/g, "");
  const layout = {
    visibleWidth: (value) => strip(value).length,
    wrap: (value, width) => value ? Array.from({ length: Math.ceil(value.length / width) }, (_, i) => value.slice(i * width, (i + 1) * width)) : [],
  };
  const rendered = renderCodexDiffLines("  2029 \n- 2030 1234567890\n+ 2030 abcdefghij\n  2031 ", 12, theme, layout);
  assert.equal(rendered[0], "  2029");
  assert.match(rendered[1], /^\x1b\[48;2;74;34;29m/);
  const firstAdd = rendered.findIndex((line) => /^\x1b\[48;2;33;58;43m/.test(line));
  assert.equal(firstAdd, 4);
  for (const line of rendered.filter((line) => /^\x1b\[48;2;(?:74;34;29|33;58;43)m/.test(line))) {
    assert.equal(strip(line).length, 12);
  }
  assert.match(strip(rendered[1]), /^  2030 -1234/);
  assert.match(strip(rendered[2]), /^        5678/);
  assert.match(strip(rendered[3]), /^        90/);
  assert.match(strip(rendered[firstAdd]), /^  2030 \+abcd/);
  assert.match(strip(rendered[firstAdd + 1]), /^        efgh/);
  assert.equal(rendered.at(-1), "  2031");
});

test("image preview setting is respected and data never appears in text", () => {
  const input = deepFreeze({ content: [{ type: "image", data: "DO-NOT-PRINT", mimeType: "image/png" }] });
  const off = formatResult("read", input, {}, theme, { showImages: false });
  assert.match(off, /1 image \(TUI preview disabled\)/);
  assert.doesNotMatch(off, /DO-NOT-PRINT/);
  assert.match(formatResult("read", input, {}, theme, { showImages: true }), /1 image/);
});

test("terminal escape sequences are stripped only from display text", () => {
  const original = "\x1b]52;c;c2VjcmV0\x07\x1b[31mRED\x1b[0m\n中文";
  assert.equal(safeText(original), "RED\n中文");
  const input = deepFreeze(result(original));
  assert.match(formatResult("read", input, { expanded: true }, theme, {}), /RED/);
  assert.equal(input.content[0].text, original);
});

test("custom components are never reused or mutated", () => {
  const r = makeRenderers((text) => new FakeText(text), () => "expand");
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
  const r = makeRenderers((text) => new FakeText(text), () => "expand");
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

test("native PowerShell commands receive the same compact execution view", () => {
  assert.match(formatCall("powershell", { command: "Get-Location" }, theme, { isPartial: false }), /• Ran Get-Location/);
});

test("syntax highlighting failures fall back without suppressing the command", () => {
  const paint = () => { throw new Error("unsupported language"); };
  assert.match(formatCall("bash", { command: "echo hello" }, theme, { isPartial: false }, undefined, paint), /echo hello/);
});

test("active shell preview follows streaming output instead of holding the oldest lines", () => {
  const output = formatResult("bash", result(lines(50)), { isPartial: true }, theme, {});
  assert.match(output, /LINE-49/);
  assert.doesNotMatch(output, /LINE-0\b/);
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
  assert.equal(calls[0].diff, payload.details.diff);
  assert.equal(calls[0].filePath, "a.ts");
  assert.equal(payload.content[0].text, "Successfully replaced text");
});
