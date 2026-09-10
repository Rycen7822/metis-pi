// Requires the actual Pi peers. This never substitutes the test layout harness.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import * as Core from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import extension from "../index.ts";
const handlers = new Map();
const source = (name, builtin = true) => ({ name, sourceInfo: {
  source: builtin ? "builtin" : "npm:compatibility-test",
  path: builtin ? `<builtin:${name}>` : "/test/custom.ts",
} });
const definitions = [source("read"), source("bash"), source("edit"), source("grep", false)];
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
const args = Object.freeze({ path: "example.ts" });
const definition = Object.freeze({ name: "read", renderCall: nativeCall });
const row = new Core.ToolExecutionComponent("read", "read-smoke", args, { showImages: false }, definition, ui, process.cwd());
row.markExecutionStarted();
const payload = { content: [{ type: "text", text: "alpha\nbeta" }], isError: false };
const saved = JSON.stringify(payload);
row.updateResult(payload);
let rendered = stripVTControlCharacters(row.render(100).join("\n"));
assert.match(rendered, /• Explored/);
assert.match(rendered, /  └ Read example\.ts/);
assert.doesNotMatch(rendered, /alpha/);
assert.equal(row.getRenderShell(), "self");
assert.equal(row.selfRenderHeight, 2);
row.setExpanded(true);
assert.match(stripVTControlCharacters(row.render(40).join("\n")), /beta/);
assert.equal(JSON.stringify(payload), saved);
assert.equal(definition.renderCall, nativeCall);
// Edit smoke: verify the live runtime uses the Codex width-aware diff component,
// not the plain fallback formatter. No file is touched; this constructs UI only.
const editArgs = Object.freeze({ path: "example.ts" });
const editDefinition = Object.freeze({ name: "edit", renderCall: nativeCall });
const editRow = new Core.ToolExecutionComponent("edit", "edit-smoke", editArgs, { showImages: false }, editDefinition, ui, process.cwd());
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
assert.doesNotMatch(editPlain, /-10 old value|\+10 new value/);

const custom = new Core.ToolExecutionComponent("grep", "custom-smoke", {}, {},
  { renderCall: nativeCall }, ui, process.cwd());
assert.match(stripVTControlCharacters(custom.render(100).join("\n")), /NATIVE/);
assert.equal(custom.getRenderShell(), "default");
handlers.get("session_shutdown")({}, {});
assert.deepEqual(Object.getOwnPropertyDescriptors(proto), before);
// No explicit invalidate here: teardown must restore the visible default child tree.
assert.match(stripVTControlCharacters(row.render(100).join("\n")), /NATIVE/);
assert.equal(row.getRenderShell(), "default");
console.log("PASS: real Pi component, compact self-shell, folded/expanded text, foreign renderer and teardown");
