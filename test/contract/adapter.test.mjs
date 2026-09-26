import test from "node:test";
import assert from "node:assert/strict";
import { installAdapter, OWNED_CONVERSION_ENTRY } from "../../src/adapter.ts";
import { makeRenderers, TOOL_NAMES } from "../../src/renderers.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { toolInfo, bindings, deepFreeze, theme, sessionStub } from "../helpers.mjs";

import { isolatedToolHost } from "../helpers/native-tool.mjs";

initTheme("dark", false);

const plain = (row) => stripVTControlCharacters(row.render(80).join("\n"));

const ownRenderers = () => makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, undefined, sessionStub);
function setup(t, tools = TOOL_NAMES.map((name) => toolInfo(name)), options = {}, Host = isolatedToolHost()) {
  const renderers = ownRenderers();
  const original = Object.getOwnPropertyDescriptors(Host.prototype);
  const handle = installAdapter(Host.prototype, { getTools: () => tools, enabled: () => true, renderers, ...options });
  t.after(() => handle.dispose());
  return { Host, renderers, original, handle };
}

function assertNative(row) {
  assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall, row.toolName);
  assert.equal(row.getResultRenderer(), row.toolDefinition.renderResult, row.toolName);
}

test("one native row survives install, duplicate install, disable and disposal with its tree intact", (t) => {
  const Host = isolatedToolHost();
  const execute = () => { throw new Error("An appearance plugin must not execute tools"); };
  const oldCall = () => bindings.makeText("stock");
  const definition = deepFreeze({ name: "bash", execute, renderCall: oldCall, renderResult: () => bindings.makeText("old result") });
  const row = new Host("bash", definition, { command: "npm test" });
  const children = [...row.children];
  assert.equal(row.children[1], row.contentBox);
  assert.equal(row.getRenderShell(), "default");
  let enabled = true;
  const { handle, renderers, original } = setup(t, undefined, { enabled: () => enabled }, Host);
  assert.equal(handle.installed, true);
  assert.equal(row.getCallRenderer(), renderers.bash.renderCall);
  assert.equal(row.getResultRenderer(), renderers.bash.renderResult);
  assert.equal(row.toolDefinition, definition);
  assert.equal(definition.execute, execute);
  const installed = Host.prototype.getCallRenderer;
  const { handle: duplicate } = setup(t, [], { renderers: {} }, Host);
  assert.equal(duplicate.installed, false);
  duplicate.dispose();
  assert.equal(Host.prototype.getCallRenderer, installed);
  assert.match(plain(row), /• Running npm test/);
  assert.equal(row.render(80).length, 2, "compact rows omit native Box padding");
  assert.equal(row.getRenderShell(), "self");
  assert.deepEqual(row.children, children);
  enabled = false;
  assert.match(plain(row), /stock/);
  assert.equal(row.getRenderShell(), "default");
  assert.deepEqual(row.children, children);
  enabled = true;
  assert.match(plain(row), /• Running npm test/);
  handle.dispose();
  assertNative(row);
  assert.equal(row.getRenderShell(), "default");
  assert.match(plain(row), /stock/);
  assert.equal(row.render(80).length, 4, "disposal restores native Box padding");
  assert.deepEqual(row.children, children);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original);
});

for (const [owner, names, builtin] of [
  ["FFF overrides", ["grep", "find"], false],
  ["other extensions", ["read", "write", "edit", "bash", "ls"], false],
  ["outside takeover list", ["web_search", "get_search_content", "fetch_content", "mcp", "mcp_search", "session_search", "fffind", "ffgrep", "exec_command", "apply_patch", "subagent", "lsp", "ask_user_question"], true],
]) {
  test(`${owner}: both native renderers remain unchanged`, (t) => {
    const { Host, handle } = setup(t, names.map((name) => toolInfo(name, builtin)));
    for (const name of names) {
      assertNative(new Host(name, deepFreeze({ renderCall: () => bindings.makeText("custom"), renderResult: () => bindings.makeText("custom result") })));
    }
  });
}

test("packaged patch and command rows share ownership boundaries while preserving native results and theme", (t) => {
  let sourceInfo = { source: "git:metis", path: OWNED_CONVERSION_ENTRY };
  let enabled = true;
  let patchReady = true;
  let receivedTheme;
  const patchDefinition = {
    renderCall: () => bindings.makeText("native patch"), renderResult: () => bindings.makeText("native result"),
  };
  const commandDefinition = {
    renderCall(_args, theme) {
      receivedTheme = theme;
      return bindings.makeText(theme.highlightCommandLines?.(["printf hi"])[0] ?? "native command");
    },
    renderResult: () => bindings.makeText("native result"),
  };
  const { Host, handle } = setup(t, [], {
    getTools: () => ["apply_patch", "exec_command"].map((name) => ({ name, sourceInfo })),
    enabled: () => enabled,
    ownedApplyPatch: { sourcePath: OWNED_CONVERSION_ENTRY,
      renderCall: () => patchReady ? bindings.makeText("owned diff") : undefined },
    highlightOwnedCommand: (lines) => lines.map((line) => `colored:${line}`),
    renderOwnedCommand: (command, state, expanded, originalTheme) => {
      assert.equal(originalTheme, theme);
      return bindings.makeText(`${state}:${expanded}:${command}`);
    },
  });
  const patch = new Host("apply_patch", patchDefinition);
  const command = new Host("exec_command", commandDefinition);
  assert.match(plain(patch), /owned diff/);
  assert.match(plain(command), /colored:printf hi/);
  assert.equal(command.getRenderShell(), "default");
  command.getCallRenderer()({}, theme, {});
  assert.equal(receivedTheme.fg("accent", "x"), theme.fg("accent", "x"));
  assert.equal(theme.highlightCommandLines, undefined);
  assert.equal(theme.renderCommandCall, undefined);
  assert.deepEqual(receivedTheme.renderCommandCall("raw command", "done", true).render(80), ["done:true:raw command"]);
  for (const row of [patch, command]) {
    row.updateResult({ content: [] });
    assert.match(plain(row), /native result/);
  }
  assert.equal(patch.toolDefinition, patchDefinition);
  assert.equal(command.toolDefinition, commandDefinition);
  patchReady = false;
  patch.updateDisplay();
  assert.match(plain(patch), /native patch/, "unavailable owned diff falls back");
  enabled = false;
  for (const row of [patch, command]) assertNative(row);
  enabled = true;
  for (const source of [
    { source: "npm:other", path: "/other/dist/index.js" },
    { source: "builtin", path: "<builtin:exec_command>" },
    { path: OWNED_CONVERSION_ENTRY },
  ]) {
    sourceInfo = source;
    for (const row of [patch, command]) assertNative(row);
  }
  sourceInfo = { source: "git:metis", path: OWNED_CONVERSION_ENTRY };
  handle.dispose();
  for (const row of [patch, command]) assertNative(row);
});

test("an earlier patch on ANY intercepted method prevents installation, atomically", (t) => {
  for (const key of ["getResultRenderer", "getRenderShell", "render"]) {
    const Host = isolatedToolHost();
    Host.prototype[key] = function () { return "another extension"; };
    const before = Object.getOwnPropertyDescriptors(Host.prototype);
    const { handle } = setup(t, [], { renderers: {} }, Host);
    assert.equal(handle.installed, false, key);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before, key);
  }
});

test("sealed prototypes and unrecognized host versions fail closed", (t) => {
  for (const Host of [isolatedToolHost(), class Unknown {}]) {
    Object.preventExtensions(Host.prototype);
    const { handle } = setup(t, [], { renderers: {} }, Host);
    assert.equal(handle.installed, false);
  }
});

test("later plugin patches are neither overridden nor undone", (t) => {
  const { Host, handle } = setup(t);
  const retainedWrapper = Host.prototype.getCallRenderer;
  const later = function () { return retainedWrapper.call(this); };
  Host.prototype.getCallRenderer = later;
  const definition = { renderCall: () => bindings.makeText("original"), renderResult: () => bindings.makeText("original result") };
  const row = new Host("bash", definition);
  assertNative(row);
  handle.dispose();
  assert.equal(Host.prototype.getCallRenderer, later);
  assert.equal(row.getCallRenderer(), definition.renderCall);
});
