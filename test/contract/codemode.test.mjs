import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme, InteractiveMode, createCodemodeExtension, createReadToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { installAdapter } from "../../src/adapter.ts";
import { activate } from "../../src/extension.ts";
import { CodemodeViewStore, makeCodemodeRenderers } from "../../src/codemode-view.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { bindings, sessionStub, toolInfo, deepFreeze } from "../helpers.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";

initTheme("dark", false);
const parent = "native-test";
const code = 'const JS_ONLY_MARKER = "script";\n'.repeat(14) + 'text(await tools.read({path:"note.md"}));';
const plain = (component, width = 80) => stripVTControlCharacters(component.render(width).join("\n"));
const call = (id, name, args, status = "ok") => ({ id: `${parent}/${id}`, name, args: JSON.stringify(args), status });
function setup(t, overrides = {}, lifecycle = false) {
  const Host = isolatedToolHost(), store = new CodemodeViewStore();
  let codemode;
  createCodemodeExtension()({ registerTool: (tool) => { codemode = tool; } });
  const definitions = { codemode, read: createReadToolDefinition(process.cwd()), bash: createBashToolDefinition(process.cwd()), ...overrides };
  const prototype = {};
  for (const name of ["session", "getRegisteredToolDefinition"]) Object.defineProperty(prototype, name,
    Object.getOwnPropertyDescriptor(InteractiveMode.prototype, name));
  const context = Object.create(prototype, { runtimeHost: { value: { session: {
    getToolDefinition: (name) => definitions[name],
    extensionRunner: { resolveToolRenderers: (_name, next) => next() },
  } } } });
  const renderers = makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, undefined, sessionStub);
  const getTools = () => ["codemode", "read", "bash", ...Object.keys(overrides)].map((name) => toolInfo(name, !Object.hasOwn(overrides, name)));
  const handlers = new Map();
  const ctx = { mode: "rpc", hasUI: true, cwd: process.cwd(), ui: { notify() {} } };
  let handle;
  if (lifecycle) {
    activate({ on: (name, fn) => handlers.set(name, fn), getAllTools: getTools },
      { ...bindings, prototype: Host.prototype, interactivePrototype: prototype, readFile: () => undefined });
    handlers.get("session_start")({}, ctx);
    handle = { dispose: () => handlers.get("session_shutdown")() };
  } else {
    handle = installAdapter(Host.prototype, {
      getTools, enabled: () => true, definitionPrototype: prototype, renderers,
      makeCodemode: (resolve) => makeCodemodeRenderers({ ...bindings, store, shell: renderers.bash, resolve }),
    });
    assert.equal(handle.installed, true);
  }
  t.after(() => handle.dispose());
  const row = new Host("codemode", context.getRegisteredToolDefinition("codemode"), { code });
  const parentEvent = { toolCallId: parent, toolName: "codemode", args: { code } };
  if (lifecycle) handlers.get("tool_execution_start")(parentEvent, ctx);
  else store.start(parentEvent, true);
  function capture(id, name, args, result, isError = false) {
    const event = { toolCallId: `${parent}/${id}`, parentToolCallId: parent, toolName: name, args };
    if (lifecycle) handlers.get("tool_execution_start")(event, ctx);
    else store.start(event);
    // Actual nested end events omit args; the start owns them.
    const end = { ...event, args: undefined, result, isError };
    if (result !== undefined) {
      if (lifecycle) handlers.get("tool_execution_end")(end, ctx);
      else store.finish(end);
    }
  }
  return { row, store, handle, capture, renderers, context, handlers, ctx };
}

test("native codemode folding hides every script line and uses ordinary read/shell rendering", (t) => {
  const { row, capture } = setup(t);
  const output = Array.from({ length: 18 }, (_, i) => `output-${i}`).join("\n");
  // The final lifecycle flag wins over any stale isError on the result object.
  capture(1, "read", { path: "note.md" }, deepFreeze({ content: [{ type: "text", text: "FILE_BODY_ONLY" }], details: {}, isError: true }));
  capture(2, "bash", { command: "printf hello" }, deepFreeze({ content: [{ type: "text", text: output }], details: {} }));
  const result = deepFreeze({ content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
    { type: "text", text: "DERIVED SUMMARY KEEP" }], details: { calls: [call(1, "read", { path: "note.md" }), call(2, "bash", { command: "printf hello" })] } });
  row.updateResult(result, false);
  const folded = plain(row);
  assert.match(folded, /codemode/);
  assert.doesNotMatch(folded, /JS_ONLY_MARKER|FILE_BODY_ONLY|Script completed/);
  assert.match(folded, /Read note\.md/);
  assert.match(folded, /Ran printf hello/);
  assert.match(folded, /output-0/);
  assert.doesNotMatch(folded, /output-8\n/);
  assert.match(folded, /DERIVED SUMMARY KEEP/);
  row.setExpanded(true);
  const expanded = plain(row);
  assert.match(expanded, /JS_ONLY_MARKER/);
  assert.equal((expanded.match(/JS_ONLY_MARKER/g) ?? []).length, 14);
  assert.match(expanded, /FILE_BODY_ONLY/);
  assert.match(expanded, /output-8\n/);
  row.setExpanded(false);
  assert.doesNotMatch(plain(row), /JS_ONLY_MARKER|FILE_BODY_ONLY/);
  assert.deepEqual(result.details.calls.map((c) => c.status), ["ok", "ok"]);
});

test("parallel running calls use real lifecycle ids and independent callback state", (t) => {
  const states = [], results = [];
  const renderer = {
    renderCall(args, _theme, ctx) { states.push(ctx.state); return bindings.makeText(`custom ${args.key} ${ctx.isPartial}`); },
    renderResult(result, _opts, _theme, ctx) { results.push(ctx.isError); return bindings.makeText(result.content[0].text); },
  };
  const { row, capture } = setup(t, { lookup: renderer });
  capture(1, "lookup", { key: "one" }); capture(2, "lookup", { key: "two" });
  row.updateResult({ content: [], details: { calls: [
    { id: `${parent}/?`, name: "lookup", args: '{"key":"one"}', status: "running" },
    { id: `${parent}/?`, name: "lookup", args: '{"key":"two"}', status: "running" },
  ] } }, true);
  assert.match(plain(row), /custom one true/);
  assert.match(plain(row), /custom two true/);
  assert.notEqual(states[0], states[1]);
  capture(3, "lookup", { key: "failure" }, { content: [{ type: "text", text: "POST_HOOK_REDACTED" }], details: {} }, true);
  row.updateResult({ content: [], details: { calls: [call(3, "lookup", { key: "failure" }, "error")] }, isError: true }, false);
  assert.match(plain(row), /POST_HOOK_REDACTED/);
  assert.equal(results.at(-1), true);
});

test("uncached history keeps summaries, errors, model cost, computed output and archive path", (t) => {
  const { row, handle } = setup(t);
  row.updateResult({ content: [{ type: "text", text: "computed independent output" }], details: {
    fullOutputPath: "/tmp/full-script.txt", calls: [
      { id: `${parent}/1`, name: "read", args: '{"path":"TRUNCATED…', status: "error", error: "DENIED" },
      { id: `${parent}/models.classify/1`, name: "models.classify", args: "provider/model", status: "ok", cost: 0.03 },
    ],
  } }, false);
  assert.match(plain(row), /read/);
  assert.match(plain(row), /computed independent output/);
  assert.match(plain(row), /full-script/);
  assert.match(plain(row), /Nested results unavailable/);
  assert.match(plain(row), /models\.classify.*\$0\.030/);
  row.setExpanded(true);
  assert.match(plain(row), /DENIED/);
  handle.dispose();
  assert.match(plain(row), /JS_ONLY_MARKER/, "disposing restores the native renderer");
});

test("foreign codemode and nested renderer resolvers retain their own presentation", (t) => {
  const foreign = { renderCall: () => bindings.makeText("FOREIGN CODEMODE"), renderResult: () => bindings.makeText("foreign output") };
  const first = setup(t, { codemode: foreign });
  assert.equal(first.row.getCallRenderer(), foreign.renderCall);
  assert.match(plain(first.row), /FOREIGN CODEMODE/);
  first.handle.dispose();
  const foreignRead = { renderCall: () => bindings.makeText("FOREIGN READ"), renderResult: () => bindings.makeText("foreign result") };
  const hasResolvers = InteractiveMode.prototype.getRegisteredToolDefinition.toString().includes("resolveToolRenderers");
  const second = setup(t, hasResolvers ? {} : { read: foreignRead });
  if (hasResolvers) second.context.runtimeHost.session.extensionRunner.resolveToolRenderers = (name, next) => name === "read"
    ? { ...next(), ...foreignRead } : next();
  second.capture(1, "read", { path: "note.md" }, { content: [{ type: "text", text: "body" }], details: {} });
  second.row.updateResult({ content: [], details: { calls: [call(1, "read", { path: "note.md" })] } }, false);
  assert.match(plain(second.row), /FOREIGN READ/);
  assert.match(plain(second.row), /foreign result/);
  assert.doesNotMatch(plain(second.row), /Explored/);
});

test("appearance lifecycle supplies finalized nested results and clears them on session replacement", (t) => {
  const { row, capture, handlers, ctx } = setup(t, {}, true);
  capture(1, "read", { path: "note.md" }, { content: [{ type: "text", text: "FINAL_POST_HOOK_BODY" }], details: {} });
  row.updateResult({ content: [], details: { calls: [call(1, "read", { path: "note.md" })] } }, false);
  row.setExpanded(true);
  assert.match(plain(row), /FINAL_POST_HOOK_BODY/);
  assert.doesNotMatch(plain(row), /Nested results unavailable/);
  handlers.get("session_start")({}, ctx);
  row.setExpanded(false); row.setExpanded(true);
  assert.doesNotMatch(plain(row), /FINAL_POST_HOOK_BODY/);
  assert.match(plain(row), /Nested results unavailable/);
});

test("display cache ignores foreign parents, refuses oversized results, and clears references", () => {
  const store = new CodemodeViewStore(256);
  store.start({ toolCallId: "foreign", toolName: "codemode" }, false);
  store.start({ toolCallId: "foreign/1", parentToolCallId: "foreign", toolName: "read", args: {} });
  assert.equal(store.get("foreign", "foreign/1"), undefined);
  store.start({ toolCallId: parent, toolName: "codemode" }, true);
  store.start({ toolCallId: `${parent}/1`, parentToolCallId: parent, toolName: "read", args: { path: "small" } });
  store.finish({ toolCallId: `${parent}/1`, parentToolCallId: parent, toolName: "read", result: { content: [{ type: "text", text: "x".repeat(1024) }] } });
  assert.equal(store.get(parent, `${parent}/1`).result, undefined);
  assert.equal(store.get(parent, `${parent}/1`).isPartial, false);
  store.clear();
  assert.deepEqual(store.entries(parent), []);
});
