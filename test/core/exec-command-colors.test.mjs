import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters as plain } from "node:util";
import { highlightBashScript } from "../../src/bash-lexer.ts";
import { renderExecCommandCall, renderGroupedExecCommandCall } from "../../vendor/pi-codex-conversion/dist/ui/tool-rendering/codex-rendering.js";

const theme = { fg: (_role, text) => text, bold: text => text };
const colored = { ...theme, highlightCommandLines: lines => highlightBashScript(lines, { kind: "truecolor" }) };

test("the command color hook adds distinct token colors without changing visible text", () => {
  const command = "node --version && printf '%s' hello";
  const rendered = renderExecCommandCall(command, "done", colored, true);
  assert.equal(plain(rendered), renderExecCommandCall(command, "done", theme, true));
  assert.ok(new Set(rendered.match(/\x1b\[38;2;[\d;]+m/g)).size >= 3);
});

test("the component hook receives the original multiline command; exploration bypasses it", () => {
  const command = "node <<'JS'\n  const x = '中文';\n\n  console.log(x);\nJS";
  const component = { render: width => [`width:${width}`] };
  const rendered = renderExecCommandCall(command, "running", { ...colored,
    renderCommandCall(actual, status, expanded) {
      assert.equal(actual, command);
      assert.equal(status, "running");
      assert.equal(expanded, true);
      return component;
    },
  }, true);
  assert.equal(rendered, component);
  const delegated = { ...colored, renderCommandCall() { assert.fail("exploration must keep its native grouping"); } };
  const groups = [[{ kind: "read", path: "example.ts", command: "cat example.ts" }]];
  for (const expanded of [false, true]) {
    assert.equal(renderExecCommandCall("cat example.ts", "done", delegated, expanded), renderExecCommandCall("cat example.ts", "done", colored, expanded));
    assert.equal(renderGroupedExecCommandCall(groups, "done", delegated, expanded, ["cat example.ts"]), renderGroupedExecCommandCall(groups, "done", colored, expanded, ["cat example.ts"]));
  }
});
