import test from "node:test";
import assert from "node:assert/strict";
import { installAdapter } from "../src/adapter.ts";
import { makeRenderers, TOOL_NAMES } from "../src/renderers.ts";
import { activate } from "../src/extension.ts";
import { fakeHost, toolInfo, bindings, deepFreeze, theme, sessionStub } from "./helpers.mjs";

function setup(tools = TOOL_NAMES.map((name) => toolInfo(name))) {
  const Host = fakeHost();
  const state = { tools, enabled: true };
  const renderers = makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, sessionStub);
  const original = Object.getOwnPropertyDescriptors(Host.prototype);
  const handle = installAdapter(Host.prototype, { getTools: () => state.tools, enabled: () => state.enabled, renderers });
  return { Host, state, renderers, original, handle };
}

test("decorates builtin UI selectors, leaving definition and executor identical", () => {
  const { Host, handle, renderers, original } = setup();
  const execute = () => { throw new Error("An appearance plugin must not execute tools"); };
  const oldCall = () => "old call";
  const definition = deepFreeze({ name: "read", execute, renderCall: oldCall, renderResult: () => "old result" });
  const row = new Host("read", definition);
  assert.equal(handle.installed, true);
  assert.equal(row.getCallRenderer(), renderers.read.renderCall);
  assert.equal(row.getResultRenderer(), renderers.read.renderResult);
  assert.equal(row.toolDefinition, definition);
  assert.equal(definition.execute, execute);
  assert.equal(definition.renderCall, oldCall);
  assert.notEqual(Host.prototype.getRenderShell, original.getRenderShell.value);
  assert.equal(row.getRenderShell(), "default");
  row.render(80);
  assert.equal(row.getRenderShell(), "self");
  handle.dispose();
  assert.equal(row.getCallRenderer(), oldCall);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original);
});

test("FFF override owns grep and find: both remain unchanged", () => {
  const { Host, handle } = setup([toolInfo("grep", false), toolInfo("find", false)]);
  for (const name of ["grep", "find"]) {
    const definition = deepFreeze({ renderCall: () => "fff", renderResult: () => "fff result" });
    const row = new Host(name, definition);
    assert.equal(row.getCallRenderer(), definition.renderCall);
    assert.equal(row.getResultRenderer(), definition.renderResult);
  }
  handle.dispose();
});

for (const name of ["read", "write", "edit", "bash", "ls"]) {
  test(`an extension overriding ${name} keeps both custom renderers`, () => {
    const { Host, handle } = setup([toolInfo(name, false)]);
    const definition = { renderCall: () => "custom", renderResult: () => "custom result" };
    assert.equal(new Host(name, definition).getCallRenderer(), definition.renderCall);
    assert.equal(new Host(name, definition).getResultRenderer(), definition.renderResult);
    handle.dispose();
  });
}

for (const name of ["web_search", "get_search_content", "fetch_content", "mcp", "mcp_search", "session_search", "fffind", "ffgrep", "exec_command", "apply_patch", "subagent", "lsp", "ask_user_question"]) {
  test(`does not decorate ${name}`, () => {
    const { Host, handle } = setup([toolInfo(name)]);
    const definition = { renderCall: () => "custom", renderResult: () => "custom result" };
    const row = new Host(name, definition);
    assert.equal(row.getCallRenderer(), definition.renderCall);
    assert.equal(row.getResultRenderer(), definition.renderResult);
    handle.dispose();
  });
}

test("unknown source metadata, self-shell tools and absent definitions are skipped", () => {
  for (const tools of [[{ name: "read" }], [{ name: "read", sourceInfo: { source: "builtin", path: "unknown" } }], []]) {
    const { Host, handle } = setup(tools);
    const definition = { renderCall: () => "stock" };
    assert.equal(new Host("read", definition).getCallRenderer(), definition.renderCall);
    handle.dispose();
  }
  const { Host, handle } = setup();
  const definition = { renderShell: "self", renderCall: () => "self" };
  assert.equal(new Host("read", definition).getCallRenderer(), definition.renderCall);
  assert.equal(new Host("read").getCallRenderer(), undefined);
  handle.dispose();
});

test("runtime owner changes are rechecked without changing tool activation", () => {
  const { Host, state, handle, renderers } = setup();
  const definition = { renderCall: () => "stock" };
  const row = new Host("grep", definition);
  assert.equal(row.getCallRenderer(), renderers.grep.renderCall);
  state.tools = [toolInfo("grep", false)];
  assert.equal(row.getCallRenderer(), definition.renderCall);
  state.tools = [toolInfo("grep")];
  state.enabled = false;
  assert.equal(row.getCallRenderer(), definition.renderCall);
  handle.dispose();
});

test("an earlier selector patch prevents installation, atomically", () => {
  const Host = fakeHost();
  Host.prototype.getResultRenderer = function () { return "another extension"; };
  const before = Object.getOwnPropertyDescriptors(Host.prototype);
  const handle = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: {} });
  assert.equal(handle.installed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
});

test("sealed prototypes and unrecognized host versions fail closed", () => {
  for (const Host of [fakeHost(), class Unknown {}]) {
    Object.preventExtensions(Host.prototype);
    const handle = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: {} });
    assert.equal(handle.installed, false);
  }
});

test("later plugin patches are neither overridden nor undone", () => {
  const { Host, handle } = setup();
  const retainedWrapper = Host.prototype.getCallRenderer;
  const later = function () { return retainedWrapper.call(this); };
  Host.prototype.getCallRenderer = later;
  const definition = { renderCall: () => "original", renderResult: () => "original result" };
  const row = new Host("bash", definition);
  assert.equal(row.getCallRenderer(), definition.renderCall);
  assert.equal(row.getResultRenderer(), definition.renderResult);
  handle.dispose();
  assert.equal(Host.prototype.getCallRenderer, later);
  assert.equal(row.getCallRenderer(), definition.renderCall);
});

test("duplicate installations do not stack or steal ownership", () => {
  const { Host, handle, original } = setup();
  const after = Host.prototype.getCallRenderer;
  const duplicate = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: {} });
  assert.equal(duplicate.installed, false);
  duplicate.dispose();
  assert.equal(Host.prototype.getCallRenderer, after);
  handle.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), original);
});

test("registry failures fall back to the original renderer", () => {
  const Host = fakeHost();
  const handle = installAdapter(Host.prototype, {
    getTools() { throw new Error("registry not initialized"); }, enabled: () => true,
    renderers: makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, sessionStub),
  });
  const definition = { renderCall: () => "old" };
  assert.equal(new Host("bash", definition).getCallRenderer(), definition.renderCall);
  handle.dispose();
});

test("lifecycle uses no tool registration, context middleware, editor, footer or hotkey API", () => {
  const handlers = new Map();
  const allowed = {
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => TOOL_NAMES.map((name) => toolInfo(name)),
  };
  const pi = new Proxy(allowed, { get(target, key) {
    if (!(key in target)) throw new Error(`Forbidden API: ${String(key)}`);
    return target[key];
  } });
  const Host = fakeHost();
  const before = Object.getOwnPropertyDescriptors(Host.prototype);
  activate(pi, { ...bindings, prototype: Host.prototype });
  assert.deepEqual([...handlers.keys()], [
    "session_start",
    "tool_execution_start", // observe-only write tracking (0.4.0)
    "tool_execution_end",
    "message_start", // read-only display-order observation (0.6.0 grouping)
    "message_update",
    "message_end",
    "session_shutdown",
  ]);
  const ctx = { hasUI: true, ui: { notify() { throw new Error("unexpected warning"); } } };
  for (let i = 0; i < 5; i++) {
    handlers.get("session_start")({}, ctx);
    assert.notEqual(Host.prototype.getCallRenderer, before.getCallRenderer.value);
    handlers.get("session_shutdown")({}, ctx);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
  }
});

test("noninteractive sessions do not modify prototypes", () => {
  const handlers = new Map();
  const Host = fakeHost();
  const before = Object.getOwnPropertyDescriptors(Host.prototype);
  activate({ on: (e, fn) => handlers.set(e, fn), getAllTools: () => [] }, { ...bindings, prototype: Host.prototype });
  handlers.get("session_start")({}, { hasUI: false });
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
});

test("rendering keeps search JSON, images, signatures, usage and args byte-for-byte intact", () => {
  const { Host, handle } = setup();
  const args = deepFreeze({ path: "report.json" });
  const payload = deepFreeze({
    content: [
      { type: "text", text: JSON.stringify({ results: [{ url: "https://example.com", summary: "Keep this evidence" }] }) },
      { type: "image", data: "BASE64-UNCHANGED", mimeType: "image/png" },
      { type: "text", text: "SECOND BLOCK" },
    ],
    details: { original: true, reasoning_signature: "SIGNED-CONTENT" },
    usage: { input: 142 }, isError: false,
  });
  const before = JSON.stringify(payload);
  const ctx = deepFreeze({ args, isPartial: false, showImages: false, state: { arbitrary: "unchanged" } });
  const row = new Host("read", { renderCall: () => null });
  row.getCallRenderer()(args, theme, ctx);
  const view = row.getResultRenderer()(payload, { expanded: true, isPartial: false }, theme, ctx).render(120).join("\n");
  assert.match(view, /Keep this evidence/);
  assert.match(view, /SECOND BLOCK/);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(args, { path: "report.json" });
  handle.dispose();
});


test("a later plugin freezing the prototype cannot break shutdown", () => {
  const { Host, handle } = setup();
  const definition = { renderCall: () => "native", renderResult: () => "result" };
  const row = new Host("read", definition);
  Object.freeze(Host.prototype);
  assert.doesNotThrow(() => handle.dispose());
  assert.equal(row.getCallRenderer(), definition.renderCall);
  assert.equal(row.getResultRenderer(), definition.renderResult);
  assert.doesNotThrow(() => handle.dispose());
});

test("default compact view removes the whole padded Box, not merely its background", () => {
  const { Host, handle } = setup();
  const row = new Host("bash", { renderCall: () => "stock" }, { command: "npm test" });
  const children = [...row.children];
  assert.equal(row.children[1], row.contentBox); // stock constructor tree stays intact
  const output = row.render(80).join("\n");
  assert.match(output, /• Running npm test/);
  assert.doesNotMatch(output, /BOX/);
  assert.equal(row.getRenderShell(), "self");
  assert.deepEqual(row.children, children);
  handle.dispose();
  assert.equal(row.getRenderShell(), "default");
  assert.match(row.render(80).join("\n"), /BOX TOP/);
  assert.match(row.render(80).join("\n"), /stock/);
  assert.deepEqual(row.children, children);
});

test("each completed read is a two-line Explored entry, and expansion recovers all output", () => {
  const { Host, handle } = setup();
  const row = new Host("read", { renderCall: () => "stock" }, { path: "README.md" });
  row.updateResult({ content: [{ type: "text", text: "FULL FILE CONTENT" }], isError: false });
  const output = row.render(80).filter(Boolean);
  // 0.4.0: Codex exploration colors — dim bullet, cyan "Read" verb.
  assert.deepEqual(output, [
    "\x1B[38;2;108;112;134m•\x1B[39m Explored",
    "\x1B[38;2;108;112;134m  └ \x1B[39m\x1B[38;2;148;226;213mRead\x1B[39m README.md",
  ]);
  row.setExpanded(true);
  assert.match(row.render(80).join("\n"), /FULL FILE CONTENT/);
  handle.dispose();
});

test("owner changes restore the stock shell without changing the constructor's children", () => {
  const { Host, state, handle } = setup();
  const row = new Host("grep", { renderCall: () => "current owner" }, { pattern: "test" });
  const originalChildren = [...row.children];
  assert.doesNotMatch(row.render(80).join("\n"), /BOX/);
  state.tools = [toolInfo("grep", false)];
  const output = row.render(80).join("\n");
  assert.match(output, /BOX TOP/);
  assert.match(output, /current owner/);
  assert.deepEqual(row.children, originalChildren);
  handle.dispose();
});

test("historical rows created before installation are populated before their first compact render", () => {
  const Host = fakeHost();
  const row = new Host("bash", { renderCall: () => "stock" }, { command: "pwd" });
  assert.match(row.render(80).join("\n"), /BOX TOP/);
  const handle = installAdapter(Host.prototype, { getTools: () => [toolInfo("bash")], enabled: () => true,
    renderers: makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, sessionStub) });
  const output = row.render(80).join("\n");
  assert.match(output, /• Running pwd/);
  assert.doesNotMatch(output, /BOX/);
  handle.dispose();
  assert.match(row.render(80).join("\n"), /stock/);
});

test("ordinary repaints do not regenerate the display tree", () => {
  const { Host, handle } = setup();
  const row = new Host("bash", { renderCall: () => "stock" }, { command: "pwd" });
  row.render(80);
  const n = row.refreshes;
  for (let i = 0; i < 20; i++) row.render(80 + i);
  assert.equal(row.refreshes, n);
  handle.dispose();
});

test("an earlier shell or row-render patch prevents partial installation", () => {
  for (const key of ["getRenderShell", "render"]) {
    const Host = fakeHost();
    Host.prototype[key] = () => "foreign";
    const before = Object.getOwnPropertyDescriptors(Host.prototype);
    const handle = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: {} });
    assert.equal(handle.installed, false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
  }
});

test("self-shell delegates image ordering and height to the native row renderer", () => {
  const { Host, handle } = setup();
  const row = new Host("read", { renderCall: () => "stock" }, { path: "figure.png" });
  row.updateResult({ content: [{ type: "image", data: "UNCHANGED", mimeType: "image/png" }], isError: false });
  row.imageComponents = [bindings.makeText("[IMAGE PROTOCOL OUTPUT]")];
  const image = row.imageComponents[0];
  const output = row.render(80);
  assert.equal(output.at(-1), "[IMAGE PROTOCOL OUTPUT]");
  assert.equal(row.selfRenderHeight, 3);
  assert.equal(row.imageComponents[0], image);
  assert.equal(row.result.content[0].data, "UNCHANGED");
  handle.dispose();
});
