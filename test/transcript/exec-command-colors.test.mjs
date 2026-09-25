import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters as plain } from "node:util";
import { highlightBashScript } from "../../src/bash-lexer.ts";
import { renderExecCommandCall, renderGroupedExecCommandCall } from "../../vendor/pi-codex-conversion/dist/ui/tool-rendering/codex-rendering.js";
import { summarizeShellCommand } from "../../vendor/pi-codex-conversion/dist/shell/summary.js";

const theme = { fg: (_role, text) => text, bold: text => text };
const colored = { ...theme, highlightCommandLines: lines => highlightBashScript(lines, { kind: "truecolor" }) };

test("exec commands share bash token colors without changing previews or status", () => {
  const commands = [
    "node --version && printf '%s' hello",
    "node <<'JS'\nconst value = 123;\nJS\nprintf '%s' 中文",
    Array.from({ length: 8 }, (_, i) => `printf '%s' line_${i}_${"x".repeat(120)}`).join("\n"),
  ];
  for (const command of commands) for (const expanded of [false, true]) for (const state of ["running", "done"]) {
    const native = renderExecCommandCall(command, state, theme, expanded);
    const rendered = renderExecCommandCall(command, state, colored, expanded);
    assert.equal(plain(rendered), native, "color-only: all text, truncation and status preserved");
    assert.ok(new Set(rendered.match(/\x1b\[38;2;[\d;]+m/g)).size >= 3, "multiple token colors, not one accent");
    const noColor = { ...theme, highlightCommandLines: lines => highlightBashScript(lines, { kind: "none" }) };
    assert.equal(renderExecCommandCall(command, state, noColor, expanded), native);
  }
  const script = commands[1];
  const rendered = renderExecCommandCall(script, "done", colored, true);
  for (const line of highlightBashScript(script.split("\n"), { kind: "truecolor" })) assert.ok(rendered.includes(line));
});

test("exploration grouping stays native; only expanded commands get syntax colors", () => {
  const commands = ["cat example.ts", "rg --files src"];
  const groups = commands.map(command => summarizeShellCommand(command).actions);
  const native = renderGroupedExecCommandCall(groups, "done", theme, false, commands);
  assert.equal(renderGroupedExecCommandCall(groups, "done", colored, false, commands), native);
  const expanded = renderGroupedExecCommandCall(groups, "done", colored, true, commands);
  assert.equal(plain(expanded), renderGroupedExecCommandCall(groups, "done", theme, true, commands));
  for (const command of commands) assert.ok(expanded.includes(highlightBashScript([command], { kind: "truecolor" })[0]));
  // Without metis-pi the vendor's original theme-based fallback still works.
  assert.match(renderExecCommandCall("npm test", "done", { ...theme, fg: (role, text) => `<${role}>${text}</${role}>` }), /<accent>npm test<\/accent>/);
});
