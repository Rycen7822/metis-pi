import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  InteractiveMode,
  createCodemodeExtension,
  createReadToolDefinition,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { installAdapter } from "../../src/adapter.ts";
import { activate } from "../../src/extension.ts";
import { CodemodeViewStore, makeCodemodeRenderers } from "../../src/codemode-view.ts";
import { makeRenderers } from "../../src/renderers.ts";
import { bindings, sessionStub, toolInfo, deepFreeze, theme } from "../helpers.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";

initTheme("dark", false);
const parent = "native-test";
const code = 'const JS_ONLY_MARKER = "script";\n'.repeat(14) + 'text(await tools.read({path:"note.md"}));';
const render = (component, width = 80) => component.render(width).join("\n");
const plain = (component, width = 80) => stripVTControlCharacters(render(component, width));
const makeTestRenderers = () => makeRenderers(bindings.makeText, bindings.expandHint, undefined, undefined, undefined, undefined, sessionStub);
const call = (id, name, args, status = "ok") => ({ id: `${parent}/${id}`, name, args: JSON.stringify(args), status });
function setup(t, overrides = {}, lifecycle = false, sources = {}) {
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
  const renderers = makeTestRenderers();
  const getTools = () => ["codemode", "read", "bash", ...Object.keys(overrides)].map((name) =>
    sources[name] ? { name, sourceInfo: sources[name] } : toolInfo(name, !Object.hasOwn(overrides, name)));
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

test("codemode start and timing labels use dark orange with terminal color fallbacks", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const shell = makeTestRenderers().bash;
  const scriptOutput = { content: [{ type: "text", text: "KEEP SCRIPT OUTPUT" }] };
  const body = render(shell.renderResult(scriptOutput, {}, theme, { args: {} }));
  for (const [kind, prefix] of [["truecolor", "\x1b[38;2;217;119;6m"], ["ansi256", "\x1b[38;5;172m"], ["none", ""]]) {
    const codemode = makeCodemodeRenderers({ ...bindings, store: new CodemodeViewStore(), shell,
      colorLevel: { kind }, resolve: () => undefined });
    const context = { state: {}, executionStarted: true, durationMs: 100 };
    const colored = text => prefix ? `${prefix}${text}\x1b[39m` : text;
    assert.equal(render(codemode.renderCall({ code: "text(1)" }, theme, context)), colored("codemode"), kind);
    const expanded = render(codemode.renderCall({ code: "text(1)" }, theme, { ...context, expanded: true }));
    assert.equal(expanded, `${colored("codemode")}\ntext(1)`, "script code keeps its own styling");
    assert.equal(render(codemode.renderResult({ content: [] }, { isPartial: true }, theme, context)), colored("Elapsed 0.0s"), kind);
    assert.equal(render(codemode.renderResult(scriptOutput, {}, theme, context)),
      `Script output\n${body}\n${colored("Took 0.1s")}`, "script output keeps ordinary shell styling");
  }
});

test("native codemode shows elapsed time before any nested call and stops on completion", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const { row } = setup(t);
  const invalidations = t.mock.method(row, "invalidate");
  row.updateResult({ content: [], details: { calls: [] } }, true);
  assert.match(plain(row), /Elapsed 0\.0s/);
  t.mock.timers.tick(5_000);
  assert.match(plain(row), /Elapsed 5\.0s/);
  assert.equal(invalidations.mock.callCount(), 5, "one row callback per second, even without nested calls");
  row.updateResult({ content: [], details: { calls: [] }, durationMs: 2_222 }, false);
  assert.match(plain(row), /Took 2\.2s/, "persisted duration wins over the renderer clock");
  assert.doesNotMatch(plain(row), /Elapsed/);
  const completed = invalidations.mock.callCount();
  t.mock.timers.tick(10_000);
  assert.equal(invalidations.mock.callCount(), completed, "completion clears the row interval");
  assert.match(plain(row), /Took 2\.2s/);
});

for (const [outcome, isPartial] of [["failed", true], ["cancelled", false]]) {
  test(`native codemode stops invalidating after a ${outcome} result`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
    const { row } = setup(t);
    const invalidations = t.mock.method(row, "invalidate");
    row.updateResult({ content: [], details: { calls: [] } }, true);
    assert.match(plain(row), /Elapsed 0\.0s/);
    t.mock.timers.tick(1_000);
    row.updateResult({ content: [{ type: "text", text: `Script ${outcome}` }], details: { calls: [] }, isError: true }, isPartial);
    const ended = invalidations.mock.callCount();
    const frozen = plain(row);
    t.mock.timers.tick(5_000);
    assert.equal(invalidations.mock.callCount(), ended);
    assert.equal(plain(row), frozen, "an error cannot re-arm the interval or keep elapsed time advancing");
  });
}

test("replayed codemode uses recorded minute and hour durations without starting a clock", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const intervals = t.mock.method(globalThis, "setInterval");
  const renderers = makeTestRenderers();
  const codemode = makeCodemodeRenderers({ ...bindings, store: new CodemodeViewStore(), shell: renderers.bash, resolve: () => undefined });
  for (const [durationMs, expected] of [[90_500, "1m 30s"], [7_384_000, "2h 3m 4s"]]) {
    const context = { state: {}, executionStarted: false, durationMs, invalidate() {} };
    codemode.renderCall({ code: "text(1)" }, theme, context);
    assert.equal(plain(codemode.renderResult({ content: [], details: { calls: [] } }, {}, theme, context)), `Took ${expected}`);
  }
  t.mock.timers.tick(5_000);
  assert.equal(intervals.mock.callCount(), 0, "history rows must not create live intervals");
});

test("nested FFF uses exploration rows, keeps errors/expansion and respects renderer overlays", (t) => {
  const names = ["ffgrep", "fffind"];
  const foreign = { renderCall: () => bindings.makeText("FFF ORIGINAL CALL"), renderResult: () => bindings.makeText("FFF ORIGINAL RESULT") };
  const sources = Object.fromEntries(names.map(name => [name, { source: "npm:@ff-labs/pi-fff@0.11.0", path: "/npm/pi-fff/src/index.ts" }]));
  const { row, capture, context } = setup(t, Object.fromEntries(names.map(name => [name, foreign])), true, sources);
  const args = { pattern: "needle", path: "src/" };
  capture(1, "ffgrep", args, deepFreeze({ content: [{ type: "text", text: "FFF MATCH BODY" }], details: {} }));
  capture(2, "fffind", args, deepFreeze({ content: [{ type: "text", text: "FFF ERROR BODY" }], details: {} }), true);
  row.updateResult({ content: [], details: { calls: [call(1, "ffgrep", args), call(2, "fffind", args, "error")] } }, false);
  const folded = plain(row);
  assert.match(folded, /Explored[\s\S]*Search "needle" in src\//);
  assert.match(folded, /Exploration failed[\s\S]*Find "needle" in src\//);
  assert.match(folded, /FFF ERROR BODY/);
  assert.doesNotMatch(folded, /FFF ORIGINAL|FFF MATCH BODY/);
  row.setExpanded(true);
  assert.match(plain(row), /FFF MATCH BODY/);
  context.runtimeHost.session.extensionRunner.resolveToolRenderers = (name, next) => name === "ffgrep"
    ? { ...next(), renderCall: () => bindings.makeText("FFF OVERLAY CALL"), renderResult: () => bindings.makeText("FFF OVERLAY RESULT") } : next();
  row.setExpanded(false); // The native row rebuilds its result slots on expansion changes.
  assert.match(plain(row), /FFF OVERLAY CALL[\s\S]*FFF OVERLAY RESULT/);
});

test("native codemode folding hides every script line and uses ordinary read/shell rendering", (t) => {
  const { row, capture } = setup(t);
  const output = Array.from({ length: 18 }, (_, i) => `output-${i}`).join("\n");
  // The final lifecycle flag wins over any stale isError on the result object.
  capture(
    1,
    "read",
    { path: "note.md" },
    deepFreeze({ content: [{ type: "text", text: "FILE_BODY_ONLY" }], details: {}, isError: true }),
  );
  capture(
    2,
    "bash",
    { command: "printf hello" },
    deepFreeze({ content: [{ type: "text", text: output }], details: {} }),
  );
  const result = deepFreeze({
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "DERIVED SUMMARY KEEP" },
    ],
    details: { calls: [call(1, "read", { path: "note.md" }), call(2, "bash", { command: "printf hello" })] },
  });
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

test("nested bat calls use Read exploration while mixed execution retains Ran", (t) => {
  const { row, capture } = setup(t);
  const args = { command: "bat --paging=never --style=plain --line-range 10:20 src/needle.ts" };
  const result = deepFreeze({ content: [{ type: "text", text: "BAT FILE BODY" }], details: {} });
  capture(1, "bash", args, result);
  row.updateResult({ content: [], details: { calls: [call(1, "bash", args)] } }, false);
  assert.match(plain(row), /Explored[\s\S]*Read src\/needle\.ts/);
  assert.match(plain(row), /BAT FILE BODY/);
  row.setExpanded(true);
  assert.ok(plain(row).includes(args.command));
  const mixed = { command: "bat src/needle.ts && npm test" };
  capture(2, "bash", mixed, result);
  row.updateResult({ content: [], details: { calls: [call(1, "bash", args), call(2, "bash", mixed)] } }, false);
  assert.match(plain(row), /• Ran bat src\/needle\.ts && npm test/);
  assert.match(plain(row), /Read src\/needle\.ts/, "the earlier read call remains in this script's display");
});

test("nested renderers receive their own recorded duration instead of the parent script total", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const contexts = [];
  const renderer = {
    renderCall() { return bindings.makeText("lookup"); },
    renderResult(_result, _options, _theme, context) {
      contexts.push({ id: context.toolCallId, durationMs: context.durationMs, state: context.state });
      return bindings.makeText("lookup result");
    },
  };
  const { row, capture } = setup(t, { lookup: renderer });
  const parentState = row.getRenderContext(undefined).state;
  const invalidations = t.mock.method(row, "invalidate");
  capture(1, "lookup", { key: "recorded" }, { content: [{ type: "text", text: "done" }] });
  capture(2, "lookup", { key: "unrecorded" }, { content: [{ type: "text", text: "done" }] });
  const details = { calls: [
    { ...call(1, "lookup", { key: "recorded" }), durationMs: 245 },
    call(2, "lookup", { key: "unrecorded" }),
  ] };
  row.updateResult({ content: [], details }, true);
  t.mock.timers.tick(2_000);
  assert.match(plain(row), /Elapsed 2\.0s/, "completed nested calls must not clear the parent clock");
  assert.equal(invalidations.mock.callCount(), 2);
  row.updateResult({ content: [], details, durationMs: 5_234 }, false);
  assert.match(plain(row), /Took 5\.2s/);
  const expected = new Map([[`${parent}/1`, 245], [`${parent}/2`, undefined]]);
  const states = new Map();
  for (const { id, durationMs, state } of contexts) {
    assert.ok(expected.has(id));
    assert.equal(durationMs, expected.get(id));
    assert.notEqual(state, parentState, "nested renderers never own the parent timer state");
    if (states.has(id)) assert.equal(state, states.get(id), "each call keeps its state through redraws");
    states.set(id, state);
  }
  assert.deepEqual([...states.keys()], [...expected.keys()]);
  assert.notEqual(states.get(`${parent}/1`), states.get(`${parent}/2`));
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

test("reloaded bash uses persisted complete arguments instead of the truncated preview", (t) => {
  const { row } = setup(t);
  const command = ["printf HISTORY_HEAD", ...Array(20).fill("printf middle"), "printf HISTORY_TAIL"].join("\n");
  const args = { command }, preview = JSON.stringify(args).slice(0, 197) + "...";
  const result = deepFreeze({ content: [], details: { calls: [{ ...call(1, "bash", args), args: preview }] },
    nestedCalls: { complete: true, calls: [{ id: `${parent}/1`, name: "bash", arguments: args, status: "ok" }] } });
  row.updateResult(result, false);
  assert.match(plain(row), /Ran printf HISTORY_HEAD/);
  assert.doesNotMatch(plain(row), /✓ bash|HISTORY_TAIL/);
  assert.match(plain(row), /Nested results unavailable/, "full args do not invent a missing result");
  row.setExpanded(true);
  assert.match(plain(row), /HISTORY_TAIL/);
  assert.equal(result.nestedCalls.calls[0].arguments.command, command);
});

test("live bash retains Running and Ran independently of parent script status", (t) => {
  const { row, capture } = setup(t);
  const args = { command: "printf LIVE_COMMAND" };
  capture(1, "bash", args);
  row.updateResult({ content: [], details: { calls: [{ id: `${parent}/?`, name: "bash", args: JSON.stringify(args), status: "running" }] } }, true);
  assert.match(plain(row), /Running printf LIVE_COMMAND/);
  capture(1, "bash", args, { content: [{ type: "text", text: "finished" }], details: {} });
  row.updateResult({ content: [], details: { calls: [call(1, "bash", args)] }, isError: true }, false);
  assert.match(plain(row), /Ran printf LIVE_COMMAND/);
  assert.doesNotMatch(plain(row), /Running printf LIVE_COMMAND/);
});

test("unavailable or mismatched history arguments keep a builtin bash phase without guessing", (t) => {
  const { row } = setup(t);
  for (const record of [
    { id: `${parent}/1`, name: "bash", argumentsBytes: 10000 },
    { id: `${parent}/1`, name: "read", arguments: { command: "WRONG_NAME" } },
    { id: `${parent}/2`, name: "bash", arguments: { command: "WRONG_ID" } },
  ]) {
    row.updateResult({ content: [], details: { calls: [{ ...call(1, "bash", {}), args: '{"command":"TRUNCATED...' }] },
      nestedCalls: { complete: false, calls: [record] } }, false);
    assert.match(plain(row), /Ran.*command unavailable/);
    assert.doesNotMatch(plain(row), /✓ bash|TRUNCATED|WRONG_NAME|WRONG_ID/);
  }
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
  const second = setup(t, {});
  second.context.runtimeHost.session.extensionRunner.resolveToolRenderers = (name, next) => name === "read"
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
  store.finish({
    toolCallId: `${parent}/1`,
    parentToolCallId: parent,
    toolName: "read",
    result: { content: [{ type: "text", text: "x".repeat(1024) }] },
  });
  assert.equal(store.get(parent, `${parent}/1`).result, undefined);
  assert.equal(store.get(parent, `${parent}/1`).isPartial, false);
  store.clear();
  assert.deepEqual(store.entries(parent), []);
});
