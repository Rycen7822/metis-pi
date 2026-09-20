import test from "node:test";
import assert from "node:assert/strict";
import { installAdapter } from "../../src/adapter.ts";
import { makeRenderers, TOOL_NAMES } from "../../src/renderers.ts";
import { activate } from "../../src/extension.ts";
import { fakeHost, toolInfo, bindings, deepFreeze, theme, sessionStub } from "../helpers.mjs";

function setup(tools = TOOL_NAMES.map((name) => toolInfo(name))) {
  const Host = fakeHost();
  const state = { tools, enabled: true };
  const renderers = makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, undefined, sessionStub);
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

test("an extension overriding any tool keeps both custom renderers", () => {
  for (const name of ["read", "write", "edit", "bash", "ls"]) {
    const { Host, handle } = setup([toolInfo(name, false)]);
    const definition = { renderCall: () => "custom", renderResult: () => "custom result" };
    assert.equal(new Host(name, definition).getCallRenderer(), definition.renderCall, name);
    assert.equal(new Host(name, definition).getResultRenderer(), definition.renderResult, name);
    handle.dispose();
  }
});

test("tools outside the takeover list are never decorated", () => {
  for (const name of ["web_search", "get_search_content", "fetch_content", "mcp", "mcp_search", "session_search", "fffind", "ffgrep", "exec_command", "apply_patch", "subagent", "lsp", "ask_user_question"]) {
    const { Host, handle } = setup([toolInfo(name)]);
    const definition = { renderCall: () => "custom", renderResult: () => "custom result" };
    const row = new Host(name, definition);
    assert.equal(row.getCallRenderer(), definition.renderCall, name);
    assert.equal(row.getResultRenderer(), definition.renderResult, name);
    handle.dispose();
  }
});

test("an earlier patch on ANY intercepted method prevents installation, atomically", () => {
  for (const key of ["getResultRenderer", "getRenderShell", "render"]) {
    const Host = fakeHost();
    Host.prototype[key] = function () { return "another extension"; };
    const before = Object.getOwnPropertyDescriptors(Host.prototype);
    const handle = installAdapter(Host.prototype, { getTools: () => [], enabled: () => true, renderers: {} });
    assert.equal(handle.installed, false, key);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before, key);
  }
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
  // Different event names dispatch independently; only membership matters.
  assert.deepEqual([...handlers.keys()].sort(), [
    "session_start",
    "agent_start", // interaction clock (0.8.0 working/summary)
    "agent_end",
    "agent_settled",
    "model_select", // live footer snapshot refresh (0.8.4)
    "thinking_level_select",
    "session_tree", // session-scope ledger rebuild (0.8.4)
    "session_compact",
    "session_compact_failed",
    "ui_prompt_start", // Waiting-for-input phase (0.8.4)
    "ui_prompt_end",
    "tool_execution_start", // observe-only write tracking (0.4.0)
    "tool_execution_end",
    "message_start", // read-only display-order observation (0.6.0 grouping)
    "message_update",
    "message_end",
    "session_shutdown",
  ].sort());
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
  // 0.9.6: Codex exploration colors — state-tone bullet (fake theme is
  // identity, so the bullet is plain), dim gutter, blue "Read" verb.
  assert.deepEqual(output, [
    "• Explored",
    "\x1B[38;2;108;112;134m  └ \x1B[39m\x1B[38;2;58;150;221mRead\x1B[39m README.md",
  ]);
  row.setExpanded(true);
  assert.match(row.render(80).join("\n"), /FULL FILE CONTENT/);
  handle.dispose();
});

test("historical rows created before installation are populated before their first compact render", () => {
  const Host = fakeHost();
  const row = new Host("bash", { renderCall: () => "stock" }, { command: "pwd" });
  assert.match(row.render(80).join("\n"), /BOX TOP/);
  const handle = installAdapter(Host.prototype, { getTools: () => [toolInfo("bash")], enabled: () => true,
    renderers: makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, undefined, sessionStub) });
  const output = row.render(80).join("\n");
  assert.match(output, /• Running pwd/);
  assert.doesNotMatch(output, /BOX/);
  handle.dispose();
  assert.match(row.render(80).join("\n"), /stock/);
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
