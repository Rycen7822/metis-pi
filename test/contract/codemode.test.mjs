import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import * as Tui from "@earendil-works/pi-tui";
import { altScreen, container, screenLines, drag, installCopyPrototypes, copyFrame, select } from "../helpers/ui-fixtures.mjs";
import { createFullscreenLayout } from "../../src/appearance/chrome/fullscreen-layout.ts";
import { createHistoryWindowSystem } from "../../src/appearance/chrome/history-window.ts";
import {
  initTheme,
  InteractiveMode,
  ToolExecutionComponent,
  createCodemodeExtension,
  createReadToolDefinition,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { installAdapter } from "../../src/appearance/tool-host-adapter.ts";
import { activate } from "../../src/appearance/runtime.ts";
import { CodemodeViewStore, makeCodemodeRenderers } from "../../src/appearance/transcript/codemode-view.ts";
import { makeRenderers } from "../../src/presentation/renderers.ts";
import { bindings, sessionStub, toolInfo, deepFreeze, theme, sgr } from "../helpers.mjs";
import { isolatedToolHost } from "../helpers/native-tool.mjs";

initTheme("dark", false);
const parent = "native-test";
const code = 'const JS_ONLY_MARKER = "script";\n'.repeat(14) + 'text(await tools.read({path:"note.md"}));';
const render = (component, width = 80) => component.render(width).join("\n");
const plain = (component, width = 80) => stripVTControlCharacters(render(component, width));
const makeTestRenderers = (textBindings = bindings) =>
  makeRenderers(textBindings.makeText, textBindings.expandHint, undefined, undefined, undefined, undefined, sessionStub);
const call = (id, name, args, status = "ok") => ({ id: `${parent}/${id}`, name, args: JSON.stringify(args), status });
function setup(t, overrides = {}, lifecycle = false, sources = {}, options = {}) {
  const textBindings = { ...bindings, ...options.bindings };
  const Host = options.host ?? isolatedToolHost(options.ui), store = new CodemodeViewStore();
  let codemode;
  createCodemodeExtension()({ registerTool: (tool) => { codemode = tool; },
    getAllTools: () => Object.values(definitions), appendEntry() {} });
  const originalExecute = codemode.execute;
  const definitions = { codemode, read: createReadToolDefinition(process.cwd()), bash: createBashToolDefinition(process.cwd()), ...overrides };
  const prototype = {};
  for (const name of ["session", "getRegisteredToolDefinition"]) Object.defineProperty(prototype, name,
    Object.getOwnPropertyDescriptor(InteractiveMode.prototype, name));
  const context = Object.create(prototype, { runtimeHost: { value: { session: {
    getToolDefinition: (name) => definitions[name],
    extensionRunner: { resolveToolRenderers: (_name, next) => next() },
  } } } });
  const renderers = makeTestRenderers(textBindings);
  const getTools = () => ["codemode", "read", "bash", ...Object.keys(overrides)].map((name) =>
    sources[name] ? { name, sourceInfo: sources[name] } : toolInfo(name, !Object.hasOwn(overrides, name)));
  const handlers = new Map();
  const ctx = { mode: "rpc", hasUI: true, cwd: process.cwd(), ui: { notify() {} } };
  let handle;
  if (lifecycle) {
    activate({ on: (name, fn) => handlers.set(name, fn), getAllTools: getTools },
      { ...textBindings, prototype: Host.prototype, interactivePrototype: prototype, readFile: () => undefined });
    handlers.get("session_start")({}, ctx);
    handle = { dispose: () => handlers.get("session_shutdown")() };
  } else {
    handle = installAdapter(Host.prototype, {
      getTools, enabled: () => true, definitionPrototype: prototype, renderers,
      makeCodemode: (resolve) => makeCodemodeRenderers({ ...textBindings, store, shell: renderers.bash, resolve }),
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
  return { row, handle, capture, context, handlers, ctx, definition: codemode, definitions, originalExecute };
}

test("native helper execution records actual actions, preserves output and replays without JS", async (t) => {
  const fixture = { name: "fixture_lookup", description: "Fixture tool", parameters: { type: "object", properties: {} },
    namespace: { name: "fixtures" }, execute() { assert.fail("metadata discovery must not execute tools"); } };
  const { row, context, definition, definitions, originalExecute } = setup(t, { fixture_lookup: fixture });
  const script = [
    'const namespace = ["fix", "tures"].join(""); const describe = describeTool;',
    'if (false) await describeTool("UNEXECUTED");',
    'text(await describeNamespace(namespace));',
    'text(await Promise.all([describe("read"), searchTools("read file", {limit:2})]));',
  ].join("\n");
  const toolContext = { tools: Object.values(definitions), sessionManager: { getBranch: () => [] }, modelRegistry: {},
    executeTool() { assert.fail("helper metadata must not fabricate a nested tool call"); } };
  const native = await originalExecute(parent, { code: script }, undefined, undefined, toolContext);
  const updates = [];
  row.updateArgs({ code: script });
  const result = await definition.execute(parent, { code: script }, undefined, partial => {
    updates.push(partial);
    row.updateResult(partial, true);
  }, toolContext);
  assert.deepEqual(result.content.slice(1), native.content.slice(1), "only the wall-time header may differ");
  assert.deepEqual(result.details.calls, [], "helpers are not fake native child events");
  assert.deepEqual(result.details.codemodeActions.calls.map(action => [action.name, action.arguments, action.status]), [
    ["describeNamespace", ["fixtures"], "ok"], ["describeTool", ["read"], "ok"],
    ["searchTools", ["read file", "limit=2"], "ok"],
  ]);
  assert.ok(updates.some(update => update.details.codemodeActions?.calls.some(action => action.status === "running")));
  row.updateResult(result, false);
  assert.match(plain(row), /Describe namespace fixtures[\s\S]*Describe tool read[\s\S]*Search tools read file limit=2/);
  assert.doesNotMatch(plain(row), /UNEXECUTED|const namespace|Promise\.all|Script output|Nested results unavailable/);
  clickRow(row, "Describe tool read");
  assert.match(plain(row), /Describe tool read\n  Status: ok/);
  const replay = new row.constructor("codemode", context.getRegisteredToolDefinition("codemode"), { code: script });
  replay.updateResult(JSON.parse(JSON.stringify(result)), false);
  assert.match(plain(replay), /Describe namespace fixtures/);
  assert.doesNotMatch(plain(replay), /UNEXECUTED|const namespace|Nested results unavailable/);
});

test("concurrent native scripts isolate helper metadata and release retained execution wrappers", async (t) => {
  const { CodemodeSandboxBase } = await import("@earendil-works/pi-codemode");
  const originalSandbox = CodemodeSandboxBase.prototype.execute;
  const { definition, definitions, handle, originalExecute } = setup(t);
  const gate = Promise.withResolvers();
  let arrivals = 0;
  const toolContext = { tools: Object.values(definitions), sessionManager: { getBranch: () => [] },
    modelRegistry: { async getAvailableOfType() { if (++arrivals === 2) gate.resolve(); await gate.promise; return []; } } };
  const run = (id, tool) => definition.execute(id, { code: '// @options: {"timeout_ms":10000}\n'
    + `await models.getAvailableOfType("chat"); await describeTool("${tool}"); text("done");` },
  undefined, undefined, toolContext);
  const results = await Promise.all([run("first-parent", "read"), run("second-parent", "bash")]);
  for (const [index, result] of results.entries()) {
    const id = index ? "second-parent" : "first-parent", name = index ? "bash" : "read";
    assert.ok(result.details.codemodeActions.calls.every(action => action.id.startsWith(`${id}/helper/`)));
    assert.deepEqual(result.details.codemodeActions.calls.map(action => action.arguments), [["chat"], [name]]);
  }
  assert.equal(CodemodeSandboxBase.prototype.execute, originalSandbox, "the last execution releases the shared sandbox hook");
  const retained = definition.execute;
  handle.dispose();
  assert.equal(definition.execute, originalExecute, "unload restores the native definition");
  const after = await retained("after-unload", { code: 'await describeTool("read");' }, undefined, undefined, toolContext);
  assert.equal(after.details.codemodeActions, undefined, "a retained old wrapper is a native passthrough after unload");
});

test("generation streams a bounded source preview, then folds it without overwriting explicit expansion", (t) => {
  installCopyPrototypes(t);
  class StreamingHost extends ToolExecutionComponent {
    constructor(name, definition, args) {
      super(name, parent, args, { showImages: false }, definition, { requestRender() {} }, process.cwd());
    }
  }
  for (const key of ["getCallRenderer", "getResultRenderer", "getRenderShell", "render"])
    Object.defineProperty(StreamingHost.prototype, key, Object.getOwnPropertyDescriptor(ToolExecutionComponent.prototype, key));
  const { row, context } = setup(t, {}, false, {}, {
    host: StreamingHost, bindings: { makeText: text => new Tui.Text(text, 0, 0) },
  });
  row.updateArgs({ code: 'const EARLY_SOURCE_MARKER = 1;\n' + code });
  assert.match(plain(row), /JS_ONLY_MARKER/, "source streams without an explicit expansion");
  assert.doesNotMatch(plain(row), /EARLY_SOURCE_MARKER|Preparing script/, "the automatic preview shows only the source tail");
  const sourceRows = plain(row).split("\n").filter(line => /^\s*[│|]/.test(line));
  assert.equal(sourceRows.length, 12, "the automatic preview is bounded to twelve visual source rows");
  const wrapped = new StreamingHost("codemode", context.getRegisteredToolDefinition("codemode"), {
    code: 'const HIDDEN_PREFIX = "' + "x".repeat(500) + 'VISIBLE_TAIL";',
  });
  const copied = select(copyFrame(wrapped, 24)).text;
  assert.match(copied, /^codemode\n/, "a clipped soft row does not merge into the title");
  assert.match(copied, /VISIBLE_TAIL/);
  assert.doesNotMatch(copied, /HIDDEN_PREFIX|[│▏]/, "copy excludes hidden source and the decorative rail");
  clickRow(row, "codemode");
  row.setArgsComplete();
  assert.match(plain(row), /EARLY_SOURCE_MARKER/, "the user's explicit expansion survives completion");
  row.markExecutionStarted();
  row.updateResult({ content: [], details: { calls: [] } }, false);
  assert.match(plain(row), /EARLY_SOURCE_MARKER/);
  const global = new StreamingHost("codemode", context.getRegisteredToolDefinition("codemode"), { code });
  global.setExpanded(true);
  global.setArgsComplete();
  assert.match(plain(global), /JS_ONLY_MARKER/, "automatic preview does not overwrite global expansion");
  const folded = new StreamingHost("codemode", context.getRegisteredToolDefinition("codemode"), { code: "" });
  const updateArgs = folded.updateArgs;
  const { tui } = altScreen(80, 30);
  const scroll = new Tui.ScrollView(container(folded), { primary: true, follow: "end" });
  tui.setLayoutRoot(scroll);
  const history = createHistoryWindowSystem(Tui);
  history.mount(tui, scroll);
  t.after(() => history.dispose());
  assert.equal(history.status().installed, true);
  const frame = () => {
    tui.doRender();
    return stripVTControlCharacters(tui.currentLayout.root.scrollContentLines.join("\n"));
  };
  frame(); // Warm the real history cache before any argument deltas arrive.
  folded.updateArgs({ code: code.slice(0, 40) });
  assert.match(frame(), /JS_ONLY_MARKER/);
  assert.doesNotMatch(frame(), /tools\.read/);
  folded.updateArgs({ code });
  assert.match(frame(), /tools\.read/, "each arriving source update is visible before completion");
  folded.setArgsComplete();
  assert.doesNotMatch(frame(), /JS_ONLY_MARKER/, "source folds as soon as generation ends, before execution starts");
  assert.match(frame(), /Preparing script/);
  folded.markExecutionStarted();
  folded.updateResult({ content: [], details: { calls: [] } }, true);
  assert.match(frame(), /Running script/);
  folded.updateResult({ content: [], details: { calls: [] } }, false);
  assert.match(frame(), /Ran script/);
  assert.doesNotMatch(frame(), /JS_ONLY_MARKER/);
  history.dispose();
  assert.equal(folded.updateArgs, updateArgs, "unmount restores the native argument updater");
});

test("codemode streams gray text inside the unchanged orange rail with terminal color fallbacks", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
  const shell = makeTestRenderers().bash;
  const scriptOutput = { content: [{ type: "text", text: "KEEP SCRIPT OUTPUT" }] };
  const body = render(shell.renderResult(scriptOutput, {}, theme, { args: {} }));
  for (const [kind, prefix, gray] of [
    ["truecolor", "\x1b[38;2;217;119;6m", "\x1b[38;2;163;163;163m"],
    ["ansi256", "\x1b[38;5;172m", "\x1b[38;5;248m"], ["none", "", ""],
  ]) {
    const codemode = makeCodemodeRenderers({ ...bindings, store: new CodemodeViewStore(), shell,
      colorLevel: { kind }, highlight: source => `HIGHLIGHT(${source})`, resolve: () => undefined });
    const context = { state: {}, executionStarted: true, durationMs: 100 };
    const colored = text => prefix ? `${prefix}${text}\x1b[39m` : text;
    const rail = kind === "none" ? "|" : colored("│");
    const streamTheme = { ...theme, fg(role, text) {
      if (role !== "muted") return theme.fg(role, text);
      return gray ? `${gray}${text}\x1b[39m` : text;
    } };
    const streaming = { state: {}, argsComplete: false, executionStarted: false, isPartial: true };
    assert.equal(render(codemode.renderCall({ code: "text(1)" }, streamTheme, streaming)),
      `${colored("codemode")}\n${rail} ${gray ? `${gray}text(1)\x1b[39m` : "text(1)"}`,
      "generation uses gray source, not syntax highlighting");
    assert.equal(render(codemode.renderCall({ code: "text(1)" }, theme, context)), colored("codemode"), kind);
    const expanded = render(codemode.renderCall({ code: "text(1)" }, theme, { ...context, expanded: true }));
    assert.equal(expanded, `${colored("codemode")}\n${rail} HIGHLIGHT(text(1))`, "completed source retains explicit highlighting");
    assert.equal(render(codemode.renderResult({ content: [] }, { isPartial: true }, theme, context)),
      `• Running script\n${colored("Elapsed 0.0s")}`, kind);
    assert.equal(render(codemode.renderResult(scriptOutput, {}, theme, context)),
      `• Ran script\n${colored("Took 0.1s")}`, "execution summary remains visible while output stays independently folded");
    assert.equal(render(codemode.renderResult(scriptOutput, { expanded: true }, theme, context)),
      `• Ran script\nScript output\n${body}\n${colored("Took 0.1s")}`, "expanded output keeps ordinary shell styling");
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
    assert.match(frozen, /\[error\]/, "hiding script output must not hide the failure status");
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
    assert.equal(plain(codemode.renderResult({ content: [], details: { calls: [] } }, {}, theme, context)), `• Ran script\nTook ${expected}`);
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
  assert.doesNotMatch(folded, /Script output|DERIVED SUMMARY KEEP/);
  row.setExpanded(true);
  const expanded = plain(row);
  assert.match(expanded, /JS_ONLY_MARKER/);
  assert.equal((expanded.match(/JS_ONLY_MARKER/g) ?? []).length, 14);
  assert.match(expanded, /FILE_BODY_ONLY/);
  assert.match(expanded, /DERIVED SUMMARY KEEP/, "the global shortcut remains a keyboard path to script output");
  assert.match(expanded, /output-8\n/);
  clickRow(row, "output-17");
  assert.doesNotMatch(plain(row), /output-8\n/, "clicking shell output collapses its call");
  assert.match(plain(row), /JS_ONLY_MARKER[\s\S]*FILE_BODY_ONLY/, "other globally expanded blocks stay open");
  clickRow(row, "Ran printf hello");
  assert.match(plain(row), /output-8\n/);
  row.setExpanded(false);
  assert.doesNotMatch(plain(row), /JS_ONLY_MARKER|FILE_BODY_ONLY/);
});

function clickRow(row, target, occurrence = 0, width = 80) {
  const lines = row.render(width).map(stripVTControlCharacters);
  const y = lines.map((line, index) => line.includes(target) ? index : -1).filter(index => index >= 0)[occurrence];
  assert.notEqual(y, undefined, `click target visible: ${target}`);
  const event = { type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width, height: lines.length, shift: false, alt: false, ctrl: false };
  assert.equal(row.handleMouse(event)?.handled, true, "click consumed by this block");
}

test("clicks independently toggle nested calls, source and script output through Took or its body", (t) => {
  const { row, capture } = setup(t);
  const args = { path: "same.md" };
  for (const [id, text] of [[1, "FIRST BODY"], [2, "SECOND BODY"]])
    capture(id, "read", args, deepFreeze({ content: [{ type: "text", text }], details: {} }));
  const result = deepFreeze({ content: [{ type: "text", text: Array.from({ length: 18 }, (_, i) => `SCRIPT_OUTPUT_${i}`).join("\n") }],
    details: { calls: [call(1, "read", args), call(2, "read", args)] } });
  row.updateResult(result, false);
  assert.doesNotMatch(plain(row), /Script output|SCRIPT_OUTPUT_/);
  clickRow(row, "Read same.md");
  assert.match(plain(row), /FIRST BODY/);
  assert.doesNotMatch(plain(row), /SECOND BODY|JS_ONLY_MARKER|SCRIPT_OUTPUT_/);
  clickRow(row, "Read same.md", 1);
  assert.match(plain(row), /FIRST BODY[\s\S]*SECOND BODY/);
  clickRow(row, "Read same.md");
  assert.doesNotMatch(plain(row), /FIRST BODY/);
  assert.match(plain(row), /SECOND BODY/);
  clickRow(row, "codemode");
  assert.match(plain(row), /JS_ONLY_MARKER/);
  assert.doesNotMatch(plain(row), /FIRST BODY|SCRIPT_OUTPUT_/);
  clickRow(row, "Took");
  assert.match(plain(row), /SCRIPT_OUTPUT_8/);
  clickRow(row, "SCRIPT_OUTPUT_17");
  assert.doesNotMatch(plain(row), /Script output|SCRIPT_OUTPUT_/, "a script output body click closes its output");
  assert.match(plain(row), /JS_ONLY_MARKER[\s\S]*SECOND BODY/, "output collapse leaves source and nested calls open");
  clickRow(row, "Took");
  clickRow(row, "SECOND BODY");
  assert.doesNotMatch(plain(row), /FIRST BODY|SECOND BODY/, "a body click closes only its own child call");
  assert.match(plain(row), /JS_ONLY_MARKER[\s\S]*SCRIPT_OUTPUT_8/, "script and output stay open");
  clickRow(row, "JS_ONLY_MARKER");
  assert.doesNotMatch(plain(row), /JS_ONLY_MARKER/);
  assert.match(plain(row), /SCRIPT_OUTPUT_8/);
  clickRow(row, "SCRIPT_OUTPUT_17");
  assert.doesNotMatch(plain(row), /Script output|SCRIPT_OUTPUT_/);
  clickRow(row, "Took");
  assert.match(plain(row), /SCRIPT_OUTPUT_8/, "Took can reopen output collapsed through its body");
  clickRow(row, "Took");
  assert.doesNotMatch(plain(row), /JS_ONLY_MARKER|FIRST BODY|SECOND BODY|Script output|SCRIPT_OUTPUT_/);
});

test("streaming updates retain per-ID choices and earlier-call visibility remains independent", (t) => {
  const { row, capture } = setup(t);
  const calls = [];
  for (let id = 0; id < 10; id++) {
    const args = { path: `file-${id}.md` };
    capture(id, "read", args, { content: [{ type: "text", text: `BODY_${id}_ONLY` }], details: {} });
    calls.push(call(id, "read", args));
  }
  row.updateResult({ content: [], details: { calls } }, true);
  assert.doesNotMatch(plain(row), /Read file-0/);
  clickRow(row, "earlier calls");
  assert.match(plain(row), /Read file-0/);
  assert.doesNotMatch(plain(row), /BODY_\d+_ONLY|JS_ONLY_MARKER/);
  clickRow(row, "Read file-9.md");
  assert.match(plain(row), /BODY_9_ONLY/);
  const next = { path: "file-10.md" };
  capture(10, "read", next);
  row.updateResult({ content: [], details: { calls: [...calls, call(10, "read", next, "running")] } }, true);
  assert.match(plain(row), /BODY_9_ONLY/);
  assert.doesNotMatch(plain(row), /BODY_0_ONLY|JS_ONLY_MARKER/);
  capture(10, "read", next, { content: [{ type: "text", text: "BODY_10_ONLY" }], details: {} });
  row.updateResult({ content: [], details: { calls: [...calls, call(10, "read", next)] } }, false);
  assert.match(plain(row), /BODY_9_ONLY/);
  assert.doesNotMatch(plain(row), /BODY_10_ONLY/);
  clickRow(row, "Show fewer calls");
  const later = [...calls, call(10, "read", next)];
  for (let id = 11; id < 19; id++) {
    const args = { path: `file-${id}.md` };
    capture(id, "read", args, { content: [{ type: "text", text: `BODY_${id}_ONLY` }], details: {} });
    later.push(call(id, "read", args));
  }
  row.updateResult({ content: [], details: { calls: later } }, false);
  assert.match(plain(row), /BODY_9_ONLY/, "an opened block stays visible beyond the latest eight calls");
  assert.doesNotMatch(plain(row), /Read file-0/);
  row.setExpanded(true);
  assert.match(plain(row), /JS_ONLY_MARKER[\s\S]*BODY_0_ONLY[\s\S]*BODY_10_ONLY/);
  row.setExpanded(false);
  assert.doesNotMatch(plain(row), /BODY_\d+_ONLY|JS_ONLY_MARKER|Read file-0|Read file-9/);
});

test("fullscreen clicks and copied text follow child geometry across wrapping and resize", (t) => {
  const { tui, terminal } = altScreen(64, 30);
  installCopyPrototypes(t);
  const margin = createFullscreenLayout(Tui, { margin: 2, minWidth: 40 });
  t.after(() => margin.dispose());
  margin.installOnTui(tui);
  const { row, capture } = setup(t, {}, false, {}, { ui: tui, bindings: { makeText: text => new Tui.Text(text, 0, 0) } });
  const first = { path: "long/漢字-" + "wide-".repeat(12) + "first.md" }, second = { path: "second.md" };
  capture(1, "read", first, { content: [{ type: "text", text: "FIRST WRAPPED BODY" }], details: {} });
  capture(2, "read", second, { content: [{ type: "text", text: "SECOND CLICK BODY" }], details: {} });
  row.updateResult({ content: [{ type: "text", text: "SCRIPT_COPY_START\nSCRIPT_COPY_END" }],
    details: { calls: [call(1, "read", first), call(2, "read", second)] } }, false);
  tui.setLayoutRoot(container(row));
  const click = target => {
    tui.doRender();
    const y = screenLines(tui).findIndex(line => line.includes(target));
    assert.ok(y >= 0, `fullscreen target visible: ${target}`);
    tui.handleTerminalInput(sgr(0, 4, y + 1));
    tui.handleTerminalInput(sgr(0, 4, y + 1, true));
    tui.doRender();
  };
  click("Read second.md");
  assert.match(plain(row), /SECOND CLICK BODY/);
  assert.doesNotMatch(plain(row), /FIRST WRAPPED BODY|JS_ONLY_MARKER/);
  terminal.columns = 36;
  click("Read long/");
  assert.match(plain(row, 36), /FIRST WRAPPED BODY[\s\S]*SECOND CLICK BODY/);
  const frame = copyFrame(row, 36), copied = select(frame).text;
  assert.match(copied, /Read long\/漢字-wide-/);
  assert.match(copied, /FIRST WRAPPED BODY[\s\S]*SECOND CLICK BODY/);
  assert.doesNotMatch(copied, /JS_ONLY_MARKER/);
  tui.doRender();
  const y = screenLines(tui).findIndex(line => line.includes("SECOND CLICK BODY"));
  drag(tui, 4, y + 1, 12, y + 1);
  tui.doRender();
  assert.match(plain(row, 36), /FIRST WRAPPED BODY[\s\S]*SECOND CLICK BODY/);
  click("SECOND CLICK BODY");
  assert.doesNotMatch(plain(row, 36), /JS_ONLY_MARKER|SECOND CLICK BODY/);
  assert.match(plain(row, 36), /FIRST WRAPPED BODY/);
  const foldedCopy = select(copyFrame(row, 36)).text;
  assert.doesNotMatch(foldedCopy, /SECOND CLICK BODY|JS_ONLY_MARKER/, "copy uses the newly collapsed frame");
  assert.match(foldedCopy, /FIRST WRAPPED BODY/);
  assert.doesNotMatch(foldedCopy, /SCRIPT_COPY_/);
  click("Took");
  assert.match(plain(row, 36), /SCRIPT_COPY_START[\s\S]*SCRIPT_COPY_END/);
  assert.match(select(copyFrame(row, 36)).text, /SCRIPT_COPY_START[\s\S]*SCRIPT_COPY_END/);
  tui.doRender();
  const outputY = screenLines(tui).findIndex(line => line.includes("SCRIPT_COPY_START"));
  assert.ok(outputY >= 0);
  drag(tui, 4, outputY + 1, 12, outputY + 1);
  tui.doRender();
  assert.match(plain(row, 36), /SCRIPT_COPY_END/, "drag selection does not collapse script output");
  // Xterm SGR keyboard modifier flags: Shift, Alt and Ctrl must not toggle the output.
  for (const modifier of [4, 8, 16]) {
    tui.handleTerminalInput(sgr(modifier, 4, outputY + 1));
    tui.handleTerminalInput(sgr(modifier, 4, outputY + 1, true));
    tui.doRender();
    assert.match(plain(row, 36), /SCRIPT_COPY_END/, "modified clicks preserve script output");
  }
  click("SCRIPT_COPY_END");
  assert.doesNotMatch(plain(row, 36), /Script output|SCRIPT_COPY_/);
  assert.doesNotMatch(select(copyFrame(row, 36)).text, /SCRIPT_COPY_/);
  assert.match(plain(row, 36), /FIRST WRAPPED BODY/, "the output body does not change nested expansion");
});

test("nested bat calls use Read exploration while mixed execution retains Ran", (t) => {
  const { row, capture } = setup(t);
  const args = { command: "bat --paging=never --style=plain --line-range 10:20 src/needle.ts" };
  const result = deepFreeze({ content: [{ type: "text", text: "BAT FILE BODY" }], details: {} });
  capture(1, "bash", args, result);
  row.updateResult({ content: [], details: { calls: [call(1, "bash", args)] } }, false);
  assert.match(plain(row), /Explored[\s\S]*Read src\/needle\.ts/);
  assert.match(plain(row), /BAT FILE BODY/);
  clickRow(row, "Read src/needle.ts");
  assert.ok(plain(row).includes(args.command));
  assert.doesNotMatch(plain(row), /JS_ONLY_MARKER/);
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
  assert.doesNotMatch(plain(row), /Script output|computed independent output|full-script/);
  clickRow(row, "Took");
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
  let foreignClicks = 0;
  const foreignRegion = text => new Tui.MouseRegion(bindings.makeText(text), event => {
    if (event.type === "click" && event.button === "left") { foreignClicks++; return { handled: true }; }
  });
  const foreignRead = { renderCall: () => foreignRegion("FOREIGN READ"), renderResult: () => foreignRegion("foreign result") };
  const second = setup(t, {});
  second.context.runtimeHost.session.extensionRunner.resolveToolRenderers = (name, next) => name === "read"
    ? { ...next(), ...foreignRead } : next();
  second.capture(1, "read", { path: "note.md" }, { content: [{ type: "text", text: "body" }], details: {} });
  second.row.updateResult({ content: [], details: { calls: [call(1, "read", { path: "note.md" })] } }, false);
  assert.match(plain(second.row), /FOREIGN READ/);
  assert.match(plain(second.row), /foreign result/);
  assert.doesNotMatch(plain(second.row), /Explored/);
  clickRow(second.row, "FOREIGN READ");
  assert.equal(foreignClicks, 1, "the foreign child handles the click before codemode's fallback");
  clickRow(second.row, "foreign result");
  assert.equal(foreignClicks, 2, "the result's own mouse handler also retains priority");
  assert.doesNotMatch(plain(second.row), /JS_ONLY_MARKER/);
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
