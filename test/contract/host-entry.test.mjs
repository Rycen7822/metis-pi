import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
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
const source = (name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } });

function entry(t) {
  const handlers = new Map();
  const commands = [];
  const definitions = ["read", "bash", "write", "edit"].map(source);
  const prototype = Core.ToolExecutionComponent.prototype;
  const descriptors = Object.getOwnPropertyDescriptors(prototype);
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
  });
  handlers.get("session_start")({}, { hasUI: true, ui: { notify(text) { throw new Error(text); } } });
  const ui = { requestRender() {} };
  const nativeCall = () => new Text("NATIVE", 0, 0);
  const row = (name, id, args, definition = { name, renderCall: nativeCall }, cwd = process.cwd()) =>
    new Core.ToolExecutionComponent(name, id, args, { showImages: false }, definition, ui, cwd);
  const fire = (event, ctx = { cwd: process.cwd() }) => handlers.get(event.type)(event, ctx);
  return { handlers, commands, definitions, nativeCall, row, fire };
}

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
  const { createExecCommandTool } = await import("../../vendor/pi-codex-conversion/dist/tools/exec/command-tool.js");
  const { createExecCommandTracker } = await import("../../vendor/pi-codex-conversion/dist/tools/exec/command-state.js");
  const { highlightBashScript } = await import("../../src/bash-lexer.ts");
  const { detectColorLevel } = await import("../../src/palette.ts");
  const tracker = createExecCommandTracker();
  const tool = createExecCommandTool(tracker, {}, { showOutputWhenCollapsed: true });
  h.definitions.push({ name: "exec_command", sourceInfo: {
    source: "local", path: resolve(import.meta.dirname, "../../vendor/pi-codex-conversion/dist/index.js"),
  } });
  const args = { cmd: "node --version && printf '%s' 中文" };
  tracker.recordStart("exec-entry", args.cmd);
  const row = h.row("exec_command", "exec-entry", args, tool);
  row.setArgsComplete();
  row.markExecutionStarted();
  tracker.recordPersistentSession("exec-entry", 123);
  tracker.recordEnd("exec-entry");
  row.updateResult({ content: [{ type: "text", text: "output" }], details: { output: "output", session_id: 123 }, isError: false });
  assert.match(plain(row.render(80)), /Session 123 still running/);
  tracker.recordSessionFinished(123);
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

test("shipped apply_patch executes add/move/delete and retains pre-image in folded real rows", async (t) => {
  const h = entry(t);
  const cwd = temporaryDirectory(t, "metis-entry-patch-");
  const { createApplyPatchTool } = await import("../../vendor/pi-codex-conversion/dist/tools/apply-patch/tool.js");
  const tool = createApplyPatchTool({ showDiffWhenCollapsed: true });
  const root = resolve(import.meta.dirname, "../..");
  h.definitions.push({ name: "apply_patch", sourceInfo: {
    source: root, path: join(root, "vendor/pi-codex-conversion/dist/index.js"),
  } });
  writeFileSync(join(cwd, "before.txt"), "原来的中文内容\n");
  writeFileSync(join(cwd, "deleted.txt"), Array.from({ length: 30 }, (_, i) => `deleted line ${i + 1}`).join("\n") + "\n");
  const args = { input: `*** Begin Patch
*** Update File: before.txt
*** Move to: after.txt
@@
-原来的中文内容
+新的中文内容，需要在窄终端里正确换行
*** Add File: created.ts
+export const added = true;
*** Delete File: deleted.txt
*** End Patch` };
  const row = h.row("apply_patch", "patch-entry", args, tool, cwd);
  row.setArgsComplete();
  row.markExecutionStarted();
  const result = await tool.execute("patch-entry", args, undefined, undefined, { cwd });
  assert.equal(result.details.status, "success");
  row.updateResult({ ...result, isError: false });
  const rows = row.render(32);
  const text = plain(rows);
  assert.ok(rows.every((line) => visibleWidth(line) <= 32));
  assert.match(rows.join("\n"), /\x1b\[48;2;74;34;29m/);
  assert.match(rows.join("\n"), /\x1b\[48;2;33;58;43m/);
  assert.match(text, /1 -原来的中文内容/, "deleted pre-image remains visible after execution");
  assert.match(text, /1 \+新的中文内容/);
  assert.match(text, /created.ts/);
  assert.doesNotMatch(text, /deleted line 30/);
  assert.match(text, /more rows/);
  row.setExpanded(true);
  assert.match(plain(row.render(32)), /deleted line 30/, "expansion restores the deleted file's full pre-image");
  assert.equal(existsSync(join(cwd, "before.txt")), false);
  assert.equal(existsSync(join(cwd, "deleted.txt")), false);
  assert.match(readFileSync(join(cwd, "after.txt"), "utf8"), /新的中文内容/);
  assert.match(readFileSync(join(cwd, "created.ts"), "utf8"), /added = true/);

  const failedArgs = { input: "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch" };
  const failed = h.row("apply_patch", "patch-failed-entry", failedArgs, tool, cwd);
  failed.setArgsComplete();
  failed.markExecutionStarted();
  await assert.rejects(tool.execute("patch-failed-entry", failedArgs, undefined, undefined, { cwd }));
  failed.updateResult({ content: [{ type: "text", text: "apply_patch failed" }], isError: true });
  assert.match(plain(failed.render(80)), /failed/i);
  assert.doesNotMatch(failed.render(80).join("\n"), /\x1b\[48;2;33;58;43m/);
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
