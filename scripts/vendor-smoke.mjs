#!/usr/bin/env node
/**
 * Load smoke for the vendored `@howaboua/pi-codex-conversion` entry
 * (`vendor/pi-codex-conversion/dist/index.js`).
 *
 * The repo's other gates never activate that entry: the display tests import our own
 * sources, and the pty harness only proves pi *loads* the file. This script activates it
 * against a recording fake pi and asserts the registrations the package is expected to
 * make, so a broken build or a bad vendored asset path fails loudly here.
 */
import assert from "node:assert/strict";

const ENTRY = new URL("../vendor/pi-codex-conversion/dist/index.js", import.meta.url).href;
const extension = (await import(ENTRY)).default;
assert.equal(typeof extension, "function", "vendored entry must default-export an extension factory");

const calls = { tools: [], commands: [], shortcuts: [], events: [], widgets: 0, setActiveTools: [] };
const recorded = {
  events: { emit: () => {}, on: () => {}, off: () => {} },
  on: (event) => calls.events.push(event),
  registerTool: (options) => calls.tools.push(options),
  registerCommand: (name) => calls.commands.push(name),
  registerShortcut: (key) => calls.shortcuts.push(key),
  registerWidget: () => (calls.widgets += 1),
  setActiveTools: (names) => calls.setActiveTools.push(names),
  getAllTools: () => [],
  getActiveTools: () => [],
  updateStatus: () => {},
  notify: () => {},
  setStatus: () => {},
  getSettings: () => ({}),
  getFlag: () => undefined,
  setFlag: () => {},
};
// Unknown host APIs are tolerated: this smoke is about the vendored code loading and
// registering, not about re-implementing the host. Anything unexpected is recorded.
const pi = new Proxy(recorded, {
  get(target, property) {
    if (property in target) return target[property];
    if (typeof property !== "string") return undefined;
    return (...args) => {
      calls[property] = calls[property] ?? [];
      calls[property].push(args.length === 1 ? args[0] : args);
      return undefined;
    };
  },
});

const started = Date.now();
await extension(pi);
const elapsed = Date.now() - started;

const toolNames = calls.tools.map((tool) => tool.name);
assert.ok(toolNames.length > 0, "vendored entry registered no tools");
// Stable expectations: these are registered unconditionally by the upstream entry.
for (const expected of ["notebook", "apply_patch", "view_image"]) {
  assert.ok(toolNames.includes(expected), `vendored entry did not register ${expected} (got ${toolNames.join(", ")})`);
}
// Every tool must carry a parameters schema — the notebook tool's used to be a top-level
// union, which strict providers reject outright (see vendor/pi-codex-conversion/PATCHES.md).
for (const tool of calls.tools) {
  const wire = JSON.parse(JSON.stringify(tool.parameters ?? {}));
  assert.equal(wire.type, "object", `${tool.name}: parameters must serialize to a JSON Schema object`);
  assert.ok(!wire.anyOf, `${tool.name}: parameters must not be a top-level union`);
}

console.log(`PASS: vendored @howaboua/pi-codex-conversion ${process.env.PCX_VENDOR_VERSION ?? ""} activated in ${elapsed} ms`);
console.log(`  tools:     ${toolNames.join(", ")}`);
console.log(`  commands:  ${calls.commands.join(", ") || "(none)"}`);
console.log(`  shortcuts: ${calls.shortcuts.join(", ") || "(none)"}`);
console.log(`  events:    ${[...new Set(calls.events)].join(", ")}`);
