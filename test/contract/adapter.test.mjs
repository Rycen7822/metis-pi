import test from "node:test";
import assert from "node:assert/strict";
import { installAdapter, OWNED_EXECUTION_ENTRY } from "../../src/adapter.ts";
import { makeRenderers, TOOL_NAMES } from "../../src/renderers.ts";
import { initTheme, InteractiveMode, createReadToolDefinition } from "@earendil-works/pi-coding-agent";
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
  let reads = 0;
  const catalog = TOOL_NAMES.map((name) => toolInfo(name));
  const { handle, renderers, original } = setup(t, undefined, { enabled: () => enabled, getTools: () => { reads++; return catalog; } }, Host);
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
  reads = 0;
  assert.match(plain(row), /• Running npm test/);
  assert.equal(reads, 1, "one catalog read per synchronous native row render");
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
  ["other extensions", ["read", "write", "edit", "bash", "ls", "fffind", "ffgrep"], false],
  [
    "outside takeover list",
    [
      "web_search",
      "get_search_content",
      "fetch_content",
      "mcp",
      "mcp_search",
      "session_search",
      "exec_command",
      "subagent",
      "lsp",
      "ask_user_question",
    ],
    true,
  ],
]) {
  test(`${owner}: both native renderers remain unchanged`, (t) => {
    const { Host } = setup(
      t,
      names.map((name) => toolInfo(name, builtin)),
    );
    for (const name of names) {
      assertNative(
        new Host(
          name,
          deepFreeze({
            renderCall: () => bindings.makeText("custom"),
            renderResult: () => bindings.makeText("custom result"),
          }),
        ),
      );
    }
  });
}

test("packaged command rows preserve ownership boundaries, native results and theme", (t) => {
  let sourceInfo = { source: "git:metis", path: OWNED_EXECUTION_ENTRY };
  let enabled = true;
  let receivedTheme;
  const commandDefinition = {
    renderCall(_args, theme) {
      receivedTheme = theme;
      return bindings.makeText(theme.highlightCommandLines?.(["printf hi"])[0] ?? "native command");
    },
    renderResult: () => bindings.makeText("native result"),
  };
  const { Host, handle } = setup(t, [], {
    getTools: () => [{ name: "exec_command", sourceInfo }],
    enabled: () => enabled,
    highlightOwnedCommand: (lines) => lines.map((line) => `colored:${line}`),
    renderOwnedCommand: (command, state, expanded, originalTheme) => {
      assert.equal(originalTheme, theme);
      return bindings.makeText(`${state}:${expanded}:${command}`);
    },
  });
  const command = new Host("exec_command", commandDefinition);
  assert.match(plain(command), /colored:printf hi/);
  assert.equal(command.getRenderShell(), "default");
  command.getCallRenderer()({}, theme, {});
  assert.equal(receivedTheme.fg("accent", "x"), theme.fg("accent", "x"));
  assert.equal(theme.highlightCommandLines, undefined);
  assert.equal(theme.renderCommandCall, undefined);
  assert.deepEqual(receivedTheme.renderCommandCall("raw command", "done", true).render(80), ["done:true:raw command"]);
  command.updateResult({ content: [] });
  assert.match(plain(command), /native result/);
  assert.equal(command.toolDefinition, commandDefinition);
  enabled = false;
  assertNative(command);
  enabled = true;
  for (const source of [
    { source: "npm:other", path: "/other/dist/index.js" },
    { source: "builtin", path: "builtin:exec_command" },
    { path: OWNED_EXECUTION_ENTRY },
  ]) {
    sourceInfo = source;
    assertNative(command);
  }
  sourceInfo = { source: "git:metis", path: OWNED_EXECUTION_ENTRY };
  handle.dispose();
  assertNative(command);
});

test("compatible native wrappers retain compact rows, image rows and renderer ownership", (t) => {
  const Host = isolatedToolHost();
  for (const key of ["getCallRenderer", "getResultRenderer", "getRenderShell", "render"]) {
    const native = Host.prototype[key];
    Host.prototype[key] = function (...args) { return Reflect.apply(native, this, args); };
  }
  const definitionPrototype = {};
  const nativeSession = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "session");
  const nativeLookup = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition");
  Object.defineProperty(definitionPrototype, "session", {
    ...nativeSession, get() { return nativeSession.get.call(this); },
  });
  Object.defineProperty(definitionPrototype, "getRegisteredToolDefinition", {
    ...nativeLookup, value(...args) { return Reflect.apply(nativeLookup.value, this, args); },
  });
  let overlay = false;
  const foreignCall = () => bindings.makeText("foreign read");
  const runtimeHost = { session: {
    getToolDefinition() { return createReadToolDefinition(process.cwd()); },
    extensionRunner: { resolveToolRenderers(_name, next) {
      const base = next();
      return overlay ? { ...base, renderCall: foreignCall } : base;
    } },
  } };
  const owner = Object.create(definitionPrototype, { runtimeHost: { value: runtimeHost } });
  const { handle, renderers } = setup(t, [toolInfo("read")], { definitionPrototype }, Host);
  assert.equal(handle.installed, true, handle.reason);
  const row = new Host("read", owner.getRegisteredToolDefinition("read"), { path: "README.md" });
  assert.equal(row.getCallRenderer(), renderers.read.renderCall);
  plain(row);
  row.imageSpacers = [{ render: () => ["image spacer"] }];
  row.imageComponents = [{ render: () => ["image payload"] }];
  const lines = row.render(80);
  assert.deepEqual(lines.slice(-2), ["image spacer", "image payload"]);
  assert.equal(row.selfRenderHeight, lines.length - 3);
  overlay = true;
  const foreign = new Host("read", owner.getRegisteredToolDefinition("read"), { path: "README.md" });
  assert.equal(foreign.getCallRenderer(), foreignCall);
  assert.match(plain(foreign), /foreign read/);
  handle.dispose();
  assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall);
});

test("a selector wrapper that overrides one actual tool keeps that renderer", (t) => {
  const Host = isolatedToolHost();
  const native = Host.prototype.getCallRenderer;
  const foreign = () => bindings.makeText("foreign bash");
  Host.prototype.getCallRenderer = function () {
    return this.toolName === "bash" ? foreign : native.call(this);
  };
  const { handle } = setup(t, undefined, {}, Host);
  assert.equal(handle.installed, true, handle.reason);
  const row = new Host("bash", { renderCall: () => bindings.makeText("stock") });
  assert.equal(row.getCallRenderer(), foreign);
  assert.match(plain(row), /foreign bash/);
});

test("an incompatible earlier patch prevents installation, atomically", (t) => {
  for (const key of ["getResultRenderer", "getRenderShell", "render"]) {
    const Host = isolatedToolHost();
    Host.prototype[key] = function () { return "another extension"; };
    const before = Object.getOwnPropertyDescriptors(Host.prototype);
    const { handle } = setup(t, [], { renderers: {} }, Host);
    assert.equal(handle.installed, false, key);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before, key);
  }
});

test("a host render that drops image rows or mouse height is declined atomically", (t) => {
  for (const altered of ["images", "mouse height"]) {
    const Host = isolatedToolHost();
    const native = Host.prototype.render;
    Host.prototype.render = function (width) {
      const lines = native.call(this, width);
      if (altered === "mouse height") this.selfRenderHeight = 0;
      return altered === "images" && this.imageComponents.length ? lines.slice(0, -2) : lines;
    };
    const before = Object.getOwnPropertyDescriptors(Host.prototype);
    const { handle } = setup(t, [], {}, Host);
    assert.equal(handle.installed, false, altered);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before, altered);
  }
});

test("empty native sessions recover pre-bind history without claiming resolved overlays", (t) => {
  const definitionPrototype = {};
  for (const key of ["session", "getRegisteredToolDefinition"]) Object.defineProperty(definitionPrototype, key,
    Object.getOwnPropertyDescriptor(InteractiveMode.prototype, key));
  let reads = 0;
  const runtimeHost = { session: { getToolDefinition() { reads++; return createReadToolDefinition(process.cwd()); },
    extensionRunner: { resolveToolRenderers: (_name, base) => base() } } };
  const owner = Object.create(definitionPrototype, { runtimeHost: { value: runtimeHost } });
  const original = Object.getOwnPropertyDescriptors(definitionPrototype);
  const first = setup(t, undefined, { definitionPrototype });
  assert.equal(owner.session, runtimeHost.session); // Normal native command/session access, no tool history.
  assert.equal(reads, 0);
  first.handle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptors(definitionPrototype), original);
  const native = owner.getRegisteredToolDefinition("read");
  const stock = new first.Host("read", native, { path: "recovered.ts" });
  const foreignCall = () => bindings.makeText("UNCLAIMED OVERLAY");
  const foreign = new first.Host("read", { ...native, renderCall: foreignCall }, { path: "recovered.ts" });
  const children = [...stock.children];
  const next = setup(t, undefined, { definitionPrototype }, first.Host);
  assert.equal(next.handle.installed, true);
  stock.render(80);
  assert.equal(stock.getCallRenderer(), next.renderers.read.renderCall);
  assert.equal(foreign.getCallRenderer(), foreignCall);
  assert.deepEqual(stock.children, children);
  next.handle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptors(definitionPrototype), original);
});

test("unknown or sealed renderer lookup prevents takeover atomically", () => {
  for (const definitionPrototype of [
    { getRegisteredToolDefinition() { return { renderCall() {} }; } },
    Object.freeze({ getRegisteredToolDefinition: InteractiveMode.prototype.getRegisteredToolDefinition }),
  ]) {
    const Host = isolatedToolHost();
    const toolDescriptors = Object.getOwnPropertyDescriptors(Host.prototype);
    const lookupDescriptors = Object.getOwnPropertyDescriptors(definitionPrototype);
    const handle = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: ownRenderers(), definitionPrototype });
    assert.equal(handle.installed, false);
    assert.match(handle.reason, /renderer lookup/);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), toolDescriptors);
    assert.deepEqual(Object.getOwnPropertyDescriptors(definitionPrototype), lookupDescriptors);
  }
});

test("a frozen lookup retains only an inert owned wrapper after disposal", (t) => {
  const definitionPrototype = {};
  Object.defineProperty(definitionPrototype, "getRegisteredToolDefinition",
    Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "getRegisteredToolDefinition"));
  const { handle } = setup(t, undefined, { definitionPrototype });
  assert.equal(handle.installed, true);
  const retained = definitionPrototype.getRegisteredToolDefinition;
  Object.freeze(definitionPrototype);
  handle.dispose();
  let reads = 0;
  const definition = { name: "read", renderCall: () => bindings.makeText("retained native") };
  const owner = { session: { getToolDefinition() { reads++; return definition; },
    extensionRunner: { resolveToolRenderers: (_name, base) => base() } } };
  assert.equal(definitionPrototype.getRegisteredToolDefinition, retained);
  assert.equal(retained.call(owner, "read").renderCall, definition.renderCall);
  assert.equal(reads, 1, "inactive wrapper only invokes the original lookup");
});

test("sealed prototypes and unsupported host capabilities fail closed", (t) => {
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
