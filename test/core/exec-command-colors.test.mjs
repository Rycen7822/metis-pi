import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters as plain } from "node:util";
import { highlightBashScript } from "../../src/bash-lexer.ts";
import { renderExecCommandCall } from "../../src/execution/ui/rendering.ts";

const theme = { fg: (_role, text) => text, bold: text => text };
const colored = { ...theme, highlightCommandLines: lines => highlightBashScript(lines, { kind: "truecolor" }) };

test("commands with side effects keep the full run display while pure formatting keeps exploration", () => {
  const component = { render: width => [`width:${width}`] };
  for (const command of ["cat files | xargs rm", "cat input | tee saved", "find . -delete", "find . -exec rm {} +",
    "cat input | sort -o saved", "cat input | sed -i 's/a/b/' target", "cat input | tr a-z A-Z > saved"]) {
    assert.equal(renderExecCommandCall(command, "done", { ...theme, renderCommandCall(actual) {
      assert.equal(actual, command); return component;
    } }), component, command);
  }
  const exploration = { ...theme, renderCommandCall() { assert.fail("pure formatting remains exploration"); } };
  assert.match(renderExecCommandCall("cat input | head -n 3", "done", exploration), /Explored/);
  assert.match(renderExecCommandCall("find . -name '*.ts'", "done", exploration), /Explored/);
});

test("structural/content search and fd share exploration labels without hiding execution", () => {
  for (const [command, verb] of [
    ["rg needle src/", "Search"],
    ["ast-grep run --pattern 'foo($$$ARGS)' --lang ts src/", "Search"],
    ["ast-grep scan --inline-rules 'id: needle' src/", "Search"],
    ["ast-grep --pattern=needle --lang ts --json src/", "Search"],
    ["fd needle src/", "Find"], ["fd", "Find"],
  ]) assert.match(renderExecCommandCall(command, "done", theme), new RegExp("Explored[\\s\\S]*" + verb + " "), command);
  for (const command of [
    "ast-grep run -p foo -r bar src/", "ast-grep scan --update-all", "ast-grep scan -i",
    "fd -x rm {}", "fd --exec-batch=rm", "fd needle src/ && npm test", "rg needle src/ > saved", "fd needle &> saved", "fg",
  ]) assert.match(renderExecCommandCall(command, "done", theme), /Ran/, command);
  assert.match(renderExecCommandCall("ast-grep scan --inline-rules 'id: needle' src/", "done", theme), /Search src/);
});

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
  for (const expanded of [false, true]) {
    assert.equal(
      renderExecCommandCall("cat example.ts", "done", delegated, expanded),
      renderExecCommandCall("cat example.ts", "done", colored, expanded),
    );
  }
});
