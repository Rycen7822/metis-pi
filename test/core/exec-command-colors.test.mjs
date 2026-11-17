import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters as plain } from "node:util";
import { highlightBashScript } from "../../src/presentation/bash-lexer.ts";
import { renderExecCommandCall } from "../../src/execution/ui/rendering.ts";

const theme = { fg: (_role, text) => text, bold: text => text };
const colored = { ...theme, highlightCommandLines: lines => highlightBashScript(lines, { kind: "truecolor" }) };
const posix = { posixShell: true };

function assertOriginalCommand(command, options) {
  const component = { render: () => [] };
  const rendered = renderExecCommandCall(command, { ...theme, renderCommandCall(actual) {
    assert.equal(actual, command);
    return component;
  } }, options);
  assert.equal(rendered, component, command);
}

test("commands with side effects keep the full run display while pure formatting keeps exploration", () => {
  for (const command of ["cat files | xargs rm", "cat input | tee saved", "find . -delete", "find . -exec rm {} +",
    "cat input | sort -o saved", "cat input | sed -i 's/a/b/' target", "cat input | tr a-z A-Z > saved"])
    assertOriginalCommand(command, posix);
  const exploration = { ...theme, renderCommandCall() { assert.fail("pure formatting remains exploration"); } };
  assert.match(renderExecCommandCall("cat input | head -n 3", exploration, posix), /Explored/);
  assert.match(renderExecCommandCall("find . -name '*.ts'", exploration, posix), /Explored/);
});

test("structural/content search and fd share exploration labels without hiding execution", () => {
  for (const [command, verb] of [
    ["rg needle src/", "Search"],
    ["ast-grep run --pattern 'foo($$$ARGS)' --lang ts src/", "Search"],
    ["ast-grep scan --inline-rules 'id: needle' src/", "Search"],
    ["ast-grep --pattern=needle --lang ts --json src/", "Search"],
    ["fd needle src/", "Find"], ["fd", "Find"],
  ]) assert.match(renderExecCommandCall(command, theme, posix), new RegExp("Explored[\\s\\S]*" + verb + " "), command);
  for (const command of [
    "ast-grep run -p foo -r bar src/", "ast-grep scan --update-all", "ast-grep scan -i",
    "fd -x rm {}", "fd --exec-batch=rm", "fd needle src/ && npm test", "rg needle src/ > saved", "fd needle &> saved", "fg",
  ]) assert.match(renderExecCommandCall(command, theme, posix), /Ran/, command);
  assert.match(renderExecCommandCall("ast-grep scan --inline-rules 'id: needle' src/", theme, posix), /Search src/);
});

test("dynamic Bash operands keep the original command; quoted braces are literal", () => {
  for (const command of [
    "rg -n 'work-record|work-open' webui/src/evertrace_web/{templates/index.html,static/app.js}",
    "rg needle ./src/*.js", 'rg needle "$target"',
    "rg -n needle output-{1..3}.txt", "rg needle <(printf test)",
    "bash -lc 'rg needle webui/{templates/index.html,static/app.js}'",
  ]) assertOriginalCommand(command, posix);
  assert.match(renderExecCommandCall("rg needle 'static/app.js}'", theme, posix), /Search needle in app\.js}/);
});

test("non-POSIX or unknown executors do not infer Bash search arguments", () => {
  for (const options of [{ posixShell: false }, undefined]) {
    for (const command of [
      "rg -n 'needle' D:\\dev\\temp\\templates\\index.html",
      "rg -n 'needle' @('./templates/index.html', './static/app.js')",
      "rg -n 'needle' ./dir` with` spaces/file.txt",
      "rg -n 'needle' $target",
      "rg needle ./templates/index.html",
    ]) assertOriginalCommand(command, options);
  }
});

test("the command color hook adds distinct token colors without changing visible text", () => {
  const command = "node --version && printf '%s' hello";
  const options = { ...posix, expanded: true };
  const rendered = renderExecCommandCall(command, colored, options);
  assert.equal(plain(rendered), renderExecCommandCall(command, theme, options));
  assert.ok(new Set(rendered.match(/\x1b\[38;2;[\d;]+m/g)).size >= 3);
});

test("the component hook receives the original multiline command; exploration bypasses it", () => {
  const command = "node <<'JS'\n  const x = '中文';\n\n  console.log(x);\nJS";
  const component = { render: width => [`width:${width}`] };
  const rendered = renderExecCommandCall(command, { ...colored,
    renderCommandCall(actual, { title, expanded }) {
      assert.equal(actual, command);
      assert.equal(title, "Running");
      assert.equal(expanded, true);
      return component;
    },
  }, { ...posix, expanded: true, isPartial: true });
  assert.equal(rendered, component);
  const delegated = { ...colored, renderCommandCall() { assert.fail("exploration must keep its native grouping"); } };
  for (const expanded of [false, true]) {
    const options = { ...posix, expanded };
    assert.equal(
      renderExecCommandCall("cat example.ts", delegated, options),
      renderExecCommandCall("cat example.ts", colored, options),
    );
  }
});
