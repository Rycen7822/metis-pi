// Requires the actual Pi peers. This never substitutes the test layout harness.
// Exercises the REAL assembly path: index.ts default export + Pi's
// ToolExecutionComponent + real pi-tui width tools, zero model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import extension from "../index.ts";

const handlers = new Map();
const sourceInfo = (builtin) => builtin
  ? { source: "builtin", path: "<PLACEHOLDER>" }
  : { source: "npm:compatibility-test", path: "/test/custom.ts" };
const source = (name, builtin = true) => ({
  name,
  sourceInfo: builtin ? { source: "builtin", path: `<builtin:${name}>` } : sourceInfo(false),
});
const definitions = [source("read"), source("bash"), source("write"), source("edit"), source("grep", false)];
const pi = new Proxy({
  on: (event, handler) => handlers.set(event, handler),
  getAllTools: () => definitions,
}, { get(target, key) {
  if (!(key in target)) throw new Error(`Forbidden extension API: ${String(key)}`);
  return target[key];
} });
Core.initTheme("dark", false);
const proto = Core.ToolExecutionComponent.prototype;
const before = Object.getOwnPropertyDescriptors(proto);
extension(pi);
handlers.get("session_start")({}, { hasUI: true, ui: { notify(text) { throw new Error(text); } } });
const ui = { requestRender() {} };
const nativeCall = () => new Text("NATIVE", 0, 0);
const fire = (event, ctx = { cwd: process.cwd() }) => handlers.get(event.type)(event, ctx);

// ---- 1. Exploration: single title, folded by default ------------------------
const row = new Core.ToolExecutionComponent("read", "read-smoke", { path: "example.ts" }, { showImages: false }, { name: "read", renderCall: nativeCall }, ui, process.cwd());
row.markExecutionStarted();
const payload = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };
const saved = JSON.stringify(payload);
row.updateResult(payload);
let rendered = stripVTControlCharacters(row.render(100).join("\n"));
assert.match(rendered, /• Explored/);
assert.match(rendered, /  └ Read example\.ts/);
assert.doesNotMatch(rendered, /alpha/);
assert.equal(row.getRenderShell(), "self");
row.setExpanded(true);
assert.match(stripVTControlCharacters(row.render(40).join("\n")), /beta/);
assert.equal(JSON.stringify(payload), saved);
assert.equal(definitionSafe(row), true);
function definitionSafe(r) { return r.toolDefinition.renderCall === nativeCall; }

// ---- 2. Bash: TWO slots, ONE structural title --------------------------------
const bashRow = new Core.ToolExecutionComponent("bash", "bash-smoke", { command: "printf hello" }, { showImages: false }, { name: "bash", renderCall: nativeCall }, ui, process.cwd());
bashRow.markExecutionStarted();
const bashOut = stripVTControlCharacters(bashRow.render(80).join("\n"));
assert.match(bashOut, /• Running printf hello/);
assert.equal((bashOut.match(/• Running/g) ?? []).length, 1, "partial must have exactly one title");
bashRow.updateResult({ content: [{ type: "text", text: "hello\nworld" }], isError: false });
const bashDone = stripVTControlCharacters(bashRow.render(80).join("\n"));
assert.equal((bashDone.match(/• Ran/g) ?? []).length, 1, "exactly one Ran head");
assert.match(bashDone, /  └ hello/);
assert.match(bashDone, /world/);
assert.doesNotMatch(bashDone, /• Ran[\s\S]*• Ran/);

// ---- 3. Mouse: title click expands, second click folds -----------------------
const beforeClick = bashRow.expanded;
bashRow.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 6 });
assert.equal(bashRow.expanded, !beforeClick, "click on the row toggles expansion");
bashRow.handleMouse({ type: "click", button: "left", x: 1, y: 1, width: 80, height: 6 });
assert.equal(bashRow.expanded, beforeClick, "second click folds again");

// ---- 4. Write add: tracker fires, body shows the green surface, expandable ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-smoke-"));
const target = path.join(dir, "new.ts");
const writeRow = new Core.ToolExecutionComponent("write", "write-smoke", { path: target, content: "one\ntwo\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
writeRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "write-smoke", toolName: "write", args: { path: target, content: "one\ntwo\n" } });
fs.writeFileSync(target, "one\ntwo\n");
fire({ type: "tool_execution_end", toolCallId: "write-smoke", toolName: "write", result: { content: [{ type: "text", text: `Successfully wrote to ${target}` }] }, isError: false });
writeRow.updateResult({ content: [{ type: "text", text: `Successfully wrote to ${target}` }], isError: false });
const writeDone = stripVTControlCharacters(writeRow.render(80).join("\n"));
assert.match(writeDone, /• Added/, "tracker add must switch the title to Added");
assert.match(writeDone, /\+2 -0/);
assert.match(writeDone, /one/);
// Expansion keeps the full content reachable.
writeRow.setExpanded(true);
const writeExpanded = stripVTControlCharacters(writeRow.render(80).join("\n"));
assert.match(writeExpanded, /two/);

// ---- 5. Write unchanged: never an empty component ----------------------------
const sameTarget = path.join(dir, "same.txt");
fs.writeFileSync(sameTarget, "same\n");
const sameRow = new Core.ToolExecutionComponent("write", "same-smoke", { path: sameTarget, content: "same\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
sameRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "same-smoke", toolName: "write", args: { path: sameTarget, content: "same\n" } });
fire({ type: "tool_execution_end", toolCallId: "same-smoke", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
sameRow.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
const sameOut = stripVTControlCharacters(sameRow.render(80).join("\n"));
assert.match(sameOut, /unchanged/);
assert.match(sameOut, /same/);
sameRow.setExpanded(true);
assert.match(stripVTControlCharacters(sameRow.render(80).join("\n")), /same/);

// ---- 6. Third-party write (same name, extension source): back off fully ------
const extRow = new Core.ToolExecutionComponent("write", "ext-smoke", { path: path.join(dir, "ext.txt"), content: "x\n" }, { showImages: false }, { name: "write", renderCall: nativeCall }, ui, process.cwd());
const extDefs = [...definitions, { name: "write", sourceInfo: { source: "npm:compatibility-test", path: "/test/custom.ts" } }];
// simulate an extension-owned write being the LAST registration (Pi registry order)
const savedDefs = definitions.splice(0, definitions.length, ...extDefs.slice(-1));
extRow.markExecutionStarted();
fire({ type: "tool_execution_start", toolCallId: "ext-smoke", toolName: "write", args: { path: path.join(dir, "ext.txt"), content: "x\n" } });
// With the extension-owned tool as the only registry entry, ownership fails and
// the row falls back to NATIVE rendering.
assert.match(stripVTControlCharacters(extRow.render(80).join("\n")), /NATIVE/, "extension-owned write must fall back to the native renderer");
definitions.splice(0, definitions.length, ...savedDefs);

// ---- 7. Edit: rich diff through the same renderer ----------------------------
const editRow = new Core.ToolExecutionComponent("edit", "edit-smoke", { path: "example.ts" }, { showImages: false }, { name: "edit", renderCall: nativeCall }, ui, process.cwd());
editRow.markExecutionStarted();
editRow.updateResult({
  content: [{ type: "text", text: "Successfully replaced text" }],
  details: { diff: "  9 before\n-10 old value that wraps\n+10 new value that wraps\n  11 after" },
  isError: false,
});
const editRaw = editRow.render(24).join("\n");
const editPlain = stripVTControlCharacters(editRaw);
assert.match(editRaw, /\x1b\[48;2;74;34;29m/);
assert.match(editRaw, /\x1b\[48;2;33;58;43m/);
assert.match(editPlain, /10 -old value/);
assert.match(editPlain, /10 \+new value/);

// ---- 8. Foreign renderer + teardown unchanged --------------------------------
const custom = new Core.ToolExecutionComponent("grep", "custom-smoke", {}, {},
  { renderCall: nativeCall }, ui, process.cwd());
assert.match(stripVTControlCharacters(custom.render(100).join("\n")), /NATIVE/);
assert.equal(custom.getRenderShell(), "default");
handlers.get("session_shutdown")({}, {});
assert.deepEqual(Object.getOwnPropertyDescriptors(proto), before);
assert.match(stripVTControlCharacters(row.render(100).join("\n")), /NATIVE/);
assert.equal(row.getRenderShell(), "default");
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: real Pi two-slot assembly — one title per toolCallId, write five states, mouse expand/fold, third-party back-off, teardown restored");
