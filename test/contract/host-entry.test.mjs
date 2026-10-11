import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import appearance from "../../extensions/appearance.ts";
import { productFor } from "../../src/selection-copy/model.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";

const originalColor = [process.env.NO_COLOR, process.env.FORCE_COLOR, process.env.COLORTERM];
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
test.after(() => {
  for (const [key, value] of [["NO_COLOR", originalColor[0]], ["FORCE_COLOR", originalColor[1]], ["COLORTERM", originalColor[2]]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
Core.initTheme("dark", false);

const plain = (rows) => stripVTControlCharacters(rows.join("\n"));
const source = (name) => ({ name, sourceInfo: { source: "builtin", path: `builtin:${name}` } });

function entry(t) {
  const handlers = new Map();
  const commands = [];
  const definitions = ["read", "bash", "write", "edit"].map(source);
  const prototype = Core.ToolExecutionComponent.prototype;
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
  const interactiveDescriptors = Object.getOwnPropertyDescriptors(Core.InteractiveMode.prototype);
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => definitions,
    registerCommand: (name, options) => commands.push({ name, ...options }),
    appendEntry() {},
    registerEntryRenderer() {},
  };
  appearance(pi);
  t.after(() => {
    handlers.get("session_shutdown")({}, {});
    assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), descriptors, "entry releases the host prototype");
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(Core.InteractiveMode.prototype),
      interactiveDescriptors,
      "entry releases user timestamp decoration",
    );
  });
  const ctx = { hasUI: true, ui: { notify(text) { throw new Error(text); } } };
  handlers.get("session_start")({}, ctx);
  const ui = { requestRender() {} };
  const nativeCall = () => new Text("NATIVE", 0, 0);
  const row = (name, id, args, definition, cwd = process.cwd()) => {
    definition ??= name === "edit" ? Core.createEditToolDefinition(cwd) : { name, renderCall: nativeCall };
    const owner = Object.create(Core.InteractiveMode.prototype, { session: { value: {
      getToolDefinition: () => definition, extensionRunner: { resolveToolRenderers: (_name, base) => base() },
    } } });
    return new Core.ToolExecutionComponent(name, id, args, { showImages: false }, owner.getRegisteredToolDefinition(name), ui, cwd);
  };
  const fire = (event, ctx = { cwd: process.cwd() }) => handlers.get(event.type)(event, ctx);
  return { handlers, commands, definitions, nativeCall, row, fire, ctx };
}

test("thought summaries follow the live host theme across native rebuilds", (t) => {
  const h = entry(t);
  let color = "FIRST", calls = 0;
  const theme = { style(text, options) {
    assert.equal(this, theme);
    assert.deepEqual(options, { fg: "thinkingText", italic: true });
    calls++;
    return `${color}::${text}`;
  } };
  h.ctx.ui.theme = theme;
  const message = { role: "assistant", content: [] };
  h.fire({ type: "message_start", message }, h.ctx);
  const component = new Core.AssistantMessageComponent(message);
  message.content = [{ type: "thinking", thinking: "HIDDEN EVIDENCE" }, { type: "text", text: "Answer" }];
  h.fire({ type: "message_update", message }, h.ctx);
  h.fire({ type: "message_end", message }, h.ctx);
  component.updateContent(message, false);
  assert.match(plain(component.render(80)), /FIRST::Thought/);
  assert.doesNotMatch(plain(component.render(80)), /HIDDEN EVIDENCE/);
  color = "NEXT";
  component.invalidate();
  assert.match(plain(component.render(80)), /NEXT::Thought/);
  h.ctx.ui = { ...h.ctx.ui, theme: { style: text => `REBOUND::${text}` } };
  component.invalidate();
  assert.match(plain(component.render(80)), /REBOUND::Thought/);
  h.ctx.ui = { ...h.ctx.ui, theme: {} };
  component.invalidate();
  assert.match(plain(component.render(80)), /Thought/);
  assert.doesNotMatch(plain(component.render(80)), /REBOUND::/);
  assert.ok(calls > 1);
});

test("native renderer resolution preserves independent overlays and still compacts stock tools", async (t) => {
  const originalLookup = Object.getOwnPropertyDescriptor(Core.InteractiveMode.prototype, "getRegisteredToolDefinition");
  const h = entry(t);
  const dir = temporaryDirectory(t, "metis-renderer-owner-");
  let overlay = "stock", supported = false;
  const call = () => new Text("RESOLVER CALL", 0, 0);
  const result = () => new Text("RESOLVER RESULT", 0, 0);
  const loader = new Core.DefaultResourceLoader({ cwd: dir, agentDir: dir,
    settingsManager: Core.SettingsManager.inMemory({ packages: [], extensions: [] }),
    extensionFactories: [{ name: "renderer-owner-test", factory(pi) {
      supported = typeof pi.registerToolRenderer === "function";
      if (supported) pi.registerToolRenderer((_name, next) => {
        const base = next();
        if (overlay === "partial") return { renderCall: call, renderResult: result, renderShell: "self" };
        if (overlay === "spread") return { ...base, renderCall: call, renderResult: result };
        if (overlay === "mutate") return Object.assign(base, { renderCall: call, renderResult: result });
        if (overlay === "shell") return { ...base, renderShell: "self" };
        return base;
      });
    } }],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const runner = new Core.ExtensionRunner(loaded.extensions, loaded.runtime, dir, Core.SessionManager.inMemory(dir), {});
  let definitions = new Map([["read", Core.createReadToolDefinition(dir)], ["bash", Core.createBashToolDefinition(dir)]]);
  const owner = Object.create(Core.InteractiveMode.prototype, { session: { value: {
    getToolDefinition: name => definitions.get(name), extensionRunner: runner,
  } } });
  const create = (name = "read") => {
    const resolved = owner.getRegisteredToolDefinition(name);
    const args = name === "read" ? { path: "owned.ts" } : { command: "echo replay" };
    const row = new Core.ToolExecutionComponent(name, `resolver-${name}`, args, { showImages: false }, resolved,
      { requestRender() {} }, dir);
    row.updateResult({ content: [{ type: "text", text: "NATIVE BODY" }], details: undefined, isError: false });
    return row;
  };
  const stock = create();
  const stockDefinition = stock.toolDefinition;
  assert.match(plain(stock.render(80)), /Read owned\.ts/);
  assert.notEqual(stock.getCallRenderer(), stockDefinition.renderCall, "stock renderer is still compacted");
  if (supported) for (const mode of ["partial", "spread", "mutate", "shell"]) {
    overlay = mode;
    const row = create(), definition = row.toolDefinition, children = [...row.children];
    const frame = plain(row.render(80));
    if (mode !== "shell") assert.match(frame, /RESOLVER CALL[\s\S]*RESOLVER RESULT/, mode);
    assert.equal(row.getCallRenderer(), definition.renderCall, mode);
    assert.equal(row.getResultRenderer(), definition.renderResult, mode);
    assert.equal(row.getRenderShell(), definition.renderShell ?? "default", mode);
    assert.deepEqual(row.children, children, mode);
  }
  // The real host tears down the lease, rebuilds history, then binds its next
  // session. New bash definitions have new closure identities on both SDKs.
  for (const reason of ["resume", "fork"]) {
    overlay = "stock";
    create(); // Observe this actual native owner before invalidation.
    h.handlers.get("session_shutdown")({ reason }, {});
    definitions = new Map([["read", Core.createReadToolDefinition(dir)], ["bash", Core.createBashToolDefinition(dir)]]);
    const history = [create(), create("bash")];
    const foreign = [];
    if (supported) for (const mode of ["partial", "spread", "mutate", "shell"]) {
      overlay = mode;
      foreign.push([mode, create()]);
    }
    h.handlers.get("session_start")({}, { hasUI: true, ui: { notify() {} } });
    for (const row of history) {
      row.render(80);
      assert.notEqual(row.getCallRenderer(), row.toolDefinition.renderCall, `${reason}: ${row.toolName} stays compact`);
    }
    for (const [mode, row] of foreign) {
      row.render(80);
      assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall, `${reason}: ${mode}`);
      assert.equal(row.getResultRenderer(), row.toolDefinition.renderResult, `${reason}: ${mode}`);
      assert.equal(row.getRenderShell(), row.toolDefinition.renderShell ?? "default", `${reason}: ${mode}`);
    }
  }
  // A later foreign lookup disables takeover without being removed on shutdown.
  const prototype = Core.InteractiveMode.prototype;
  const retained = prototype.getRegisteredToolDefinition;
  const later = function (name) { return retained.call(this, name); };
  prototype.getRegisteredToolDefinition = later;
  const row = create();
  row.render(80);
  assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall);
  h.handlers.get("session_shutdown")({}, {});
  assert.equal(prototype.getRegisteredToolDefinition, later);
  // This test owns the later patch, so restore the original native descriptor.
  Object.defineProperty(prototype, "getRegisteredToolDefinition", originalLookup);
});

test("user timestamps use message time through replay, resize and output padding changes", (t) => {
  entry(t);
  const host = Object.assign(Object.create(Core.InteractiveMode.prototype), {
    chatContainer: new Container(), outputPad: 1,
    getMarkdownThemeWithSettings: () => Core.getMarkdownTheme(),
    getMarkdownTransformers: () => [],
  });
  const message = { role: "user", content: "original input", timestamp: Date.parse("2026-10-02T16:20:09Z") };
  const before = structuredClone(message);
  host.addMessageToChat(message);
  const frame = () => plain(host.chatContainer.render(80));
  assert.match(frame(), /original input[\s\S]*2026-10-03 00:20:09/);
  for (const width of [1, 18, 80]) {
    const rows = host.chatContainer.children.at(-1).render(width);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
  }
  host.outputPad = 3;
  host.chatContainer.children[0].setOutputPad(3);
  assert.match(frame(), /\n {3}2026-10-03 00:20:09/);
  assert.equal(frame().match(/2026-10-03 00:20:09/g)?.length, 1, "repaints do not append timestamps");
  host.chatContainer.clear();
  host.addMessageToChat(message, { populateHistory: false });
  assert.equal(frame().match(/2026-10-03 00:20:09/g)?.length, 1, "history rebuild keeps original send time");
  host.addMessageToChat({ role: "user", content: "", timestamp: message.timestamp });
  assert.equal(frame().match(/2026-10-03 00:20:09/g)?.length, 1, "hidden messages do not create orphan timestamps");
  assert.deepEqual(message, before, "timestamps are presentation data only");
});

test("shipped entry owns grouped read rows and images without changing the native tree", (t) => {
  const prototype = Core.ToolExecutionComponent.prototype;
  const nativeUpdate = Object.getOwnPropertyDescriptor(prototype, "updateDisplay");
  const h = entry(t);
  const payload = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };
  const before = structuredClone(payload);
  const reads = ["example", "second"].map((id) => {
    h.fire({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: `${id}.ts` } });
    h.fire({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: payload, isError: false });
    const row = h.row("read", id, { path: `${id}.ts` }, Core.createReadToolDefinition(process.cwd()));
    row.markExecutionStarted();
    row.updateResult(payload);
    return row;
  });
  const children = reads.map((row) => [...row.children]);
  const frames = reads.map((row) => plain(row.render(80)));
  assert.equal(frames.join("\n").match(/Explored/g)?.length, 1, "one exploration title spans both native tool rows");
  assert.match(frames[0], /• Explored[\s\S]*└ Read example\.ts/);
  assert.doesNotMatch(frames.join("\n"), /alpha/);
  assert.equal(reads[0].getRenderShell(), "self");
  reads.forEach((row) => row.updateDisplay());
  assert.deepEqual(reads.map((row) => plain(row.render(80))), frames, "stock display updates preserve the grouped self-shell");
  reads[0].setExpanded(true);
  assert.match(plain(reads[0].render(40)), /beta/);
  assert.deepEqual(payload, before, "entry cannot mutate the host result");

  reads[1].updateResult({ content: [
    { type: "text", text: "FULL second CONTENT" },
    { type: "image", data: "UNCHANGED", mimeType: "image/png" },
  ], isError: false });
  reads[1].setExpanded(true);
  const image = new Text("NATIVE IMAGE ROW", 0, 0);
  reads[1].imageComponents = [image];
  assert.match(plain(reads[1].render(50)), /FULL second CONTENT[\s\S]*NATIVE IMAGE ROW/);
  assert.equal(reads[1].imageComponents[0], image);
  assert.equal(reads[1].result.content[1].data, "UNCHANGED");
  assert.equal(reads[1].selfRenderHeight, 3);

  h.definitions.splice(h.definitions.findIndex(({ name }) => name === "read"), 1, {
    name: "read", sourceInfo: { source: "npm:foreign", path: "/foreign/index.ts" },
  });
  const definition = { ...Core.createReadToolDefinition(process.cwd()), renderShell: "self",
    renderCall: () => new Text("FOREIGN CALL", 0, 0), renderResult: () => new Text("FOREIGN RESULT", 0, 0) };
  const external = h.row("read", "foreign-self", {}, definition);
  external.updateResult(payload);
  assert.match(plain(external.render(80)), /FOREIGN CALL[\s\S]*FOREIGN RESULT/);
  assert.equal(external.getCallRenderer(), definition.renderCall);
  assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, "updateDisplay"), nativeUpdate,
    "the entry must not install a bypassed tool-tree mutation hook");
  h.definitions.splice(h.definitions.findIndex(({ name }) => name === "read"), 1, source("read"));
  assert.match(plain(reads[0].render(80)), /Read example\.ts/, "owned rendering resumes before shutdown");
  h.handlers.get("session_shutdown")({}, {});
  reads.forEach((row, index) => {
    row.render(80);
    assert.equal(row.getCallRenderer(), row.toolDefinition.renderCall);
    assert.equal(row.getResultRenderer(), row.toolDefinition.renderResult);
    assert.equal(row.getRenderShell(), "default");
    assert.deepEqual(row.children, children[index], "fallback keeps the native child tree");
  });
});

test("built exec_command delegates its real Pi row to the shell display", async (t) => {
  const h = entry(t);
  const { createExecCommandTool } = await import("../../src/execution/exec/command-tool.ts");
  const { highlightBashScript } = await import("../../src/bash-lexer.ts");
  const { detectColorLevel } = await import("../../src/palette.ts");
  const tool = createExecCommandTool({}, { showOutputWhenCollapsed: true });
  h.definitions.push({ name: "exec_command", sourceInfo: {
    source: "local", path: resolve(import.meta.dirname, "../../extensions/execution.ts"),
  } });
  const args = { cmd: "node --version && printf '%s' 中文" };
  const row = h.row("exec_command", "exec-entry", args, tool);
  row.setArgsComplete();
  row.markExecutionStarted();
  row.updateResult({ content: [{ type: "text", text: "output" }], details: { output: "output", session_id: 123 }, isError: false });
  assert.match(plain(row.render(80)), /Session 123 still running/);
  row.updateResult({ content: [{ type: "text", text: "output" }], details: { output: "output", exit_code: 1 }, isError: true });
  const rendered = row.render(80);
  assert.ok(rendered.join("\n").includes(highlightBashScript([args.cmd], detectColorLevel())[0]));
  assert.match(plain(rendered), /Exit code: 1/);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 80));
  const callRows = row.getCallRenderer()(args, { fg: (_role, text) => text, bold: (text) => text },
    { expanded: false, toolCallId: "exec-entry" }).render(80);
  assert.equal(productFor(callRows)?.rows.length, callRows.length, "owned exec preserves copy rows");
  assert.equal(row.toolDefinition, tool);
  assert.equal(row.getRenderShell(), "default", "vendor tool retains its own shell");
});

test("streamed write executes through the entry and real padded edits reach the diff surface", async (t) => {
  const h = entry(t);
  const cwd = temporaryDirectory(t, "metis-entry-edit-");
  const target = join(cwd, "new.ts");
  const args = { path: target, content: "# first\n## second line with CJK 中文\nthird" };
  const write = h.row("write", "write-entry", { path: target }, Core.createWriteToolDefinition(cwd), cwd);
  for (const content of [
    undefined,
    "# first",
    "# first\n## second line with CJK 中文",
    args.content,
  ]) {
    write.updateArgs(content === undefined ? { path: target } : { path: target, content });
    assert.ok(write.render(100).length > 0, "every partial argument frame reaches the native row");
  }
  write.setArgsComplete();
  write.markExecutionStarted();
  h.fire({ type: "tool_execution_start", toolCallId: "write-entry", toolName: "write", args }, { cwd });
  const result = await Core.createWriteTool(cwd).execute("write-entry", args);
  assert.equal(readFileSync(target, "utf8"), args.content, "the real write tool persists the streamed content");
  h.fire({ type: "tool_execution_end", toolCallId: "write-entry", toolName: "write", result, isError: false }, { cwd });
  write.updateResult({ ...result, isError: false });
  assert.match(plain(write.render(80)), /• Added[\s\S]*\+3 -0[\s\S]*# first/);
  write.setExpanded(true);
  assert.match(plain(write.render(80)), /third/);

  const editPath = join(cwd, "padded.txt");
  const changed = [4, 1000];
  writeFileSync(editPath, Array.from({ length: 1100 }, (_, i) => `  123 value_${i + 1}`).join("\n"));
  const editArgs = { path: editPath, edits: changed.map((number) => ({
    oldText: `  123 value_${number}\n`, newText: `  456 value_${number} 中文\n`,
  })) };
  const edited = await Core.createEditTool(cwd).execute("edit-entry", editArgs);
  assert.match(edited.details.diff, /-   4 /, "real Pi pads the diff gutter");
  const edit = h.row("edit", "edit-entry", editArgs, undefined, cwd);
  edit.markExecutionStarted();
  edit.updateResult({ ...edited, isError: false });
  const rows = edit.render(80);
  assert.ok(rows.every((line) => visibleWidth(line) <= 80));
  const text = rows.map(stripVTControlCharacters);
  for (const expected of ["     4 -  123 value_4", "     4 +  456 value_4", "  1000 -  123 value_1000", "  1000 +  456 value_1000"]) {
    assert.ok(text.some((line) => line.startsWith(expected)), expected);
  }
});

test("appearance entry registers diagnostics", (t) => {
  const h = entry(t);
  const command = h.commands.find(({ name }) => name === "codex-ui");
  assert.ok(command, "real entry registers /codex-ui");
  const messages = [];
  command.handler("", { ui: { notify: (text) => messages.push(text) } });
  const diagnostic = messages.join("\n");
  for (const part of [/metis-pi [\w.-]+ diagnostics/, /thinking=peek\/collapsed/, /composer:/, /working:/, /chrome:/, /transcript:/, /outcome:/]) {
    assert.match(diagnostic, part);
  }
});
