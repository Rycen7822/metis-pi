import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("theme removes tool backgrounds through the supported palette mechanism", () => {
  const theme = load("themes/metis-pi.json");
  assert.equal(theme.name, "metis-pi");
  for (const key of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) assert.equal(theme.colors[key], "");
  for (const value of Object.values(theme.colors)) {
    assert.ok(value === "" || /^#[0-9a-f]{6}$/i.test(value) || Object.hasOwn(theme.vars, value));
  }
  for (const key of ["toolTitle", "toolOutput", "thinkingMax", "scrollbarThumb", "searchMatchBg", "bashMode", "mdCode"]) {
    assert.ok(Object.hasOwn(theme.colors, key));
  }
});

test("chrome modules have no direct host imports (src/ rule)", () => {
  // Read the directory instead of a hardcoded list: every chrome module is covered,
  // including new ones (the factory in editor.ts explains the rule's reason).
  for (const entry of readdirSync(new URL("../src/chrome/", import.meta.url))) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`../src/chrome/${entry}`, import.meta.url), "utf8");
    assert.ok(!text.includes("from \"@earendil-works"), `src/chrome/${entry} must not import host packages directly`);
    assert.ok(!text.includes("from '@earendil-works"), `src/chrome/${entry} must not import host packages directly`);
  }
});


test("package exposes the display, goal, todo and vendored codex-conversion entries", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/*.ts", "./vendor/pi-codex-conversion/dist/index.js"]);
  assert.equal(existsSync(new URL("../extensions/appearance.ts", import.meta.url)), true);
  assert.equal(existsSync(new URL("../extensions/goal.ts", import.meta.url)), true);
  assert.equal(existsSync(new URL("../extensions/todo.ts", import.meta.url)), true);
  // The vendored codex-conversion entry is loaded from its build output, which is
  // committed (see vendor/pi-codex-conversion/UPSTREAM.md); the built entry, its
  // runtime assets and the pristine-source patch record must all ship.
  assert.equal(existsSync(new URL("../vendor/pi-codex-conversion/dist/index.js", import.meta.url)), true);
  assert.equal(existsSync(new URL("../vendor/pi-codex-conversion/vendor/tree-sitter-bash/tree-sitter-bash.wasm", import.meta.url)), true);
  assert.equal(existsSync(new URL("../vendor/pi-codex-conversion/src/tools/exec/bin/linux-x64", import.meta.url)), true);
  assert.equal(existsSync(new URL("../vendor/pi-codex-conversion/patches/local.patch", import.meta.url)), true);
  // goal.ts is vendored from an Apache-2.0 upstream, so its licence text and
  // attribution must ship with the package.
  assert.equal(existsSync(new URL("../LICENSE-APACHE-2.0", import.meta.url)), true);
  assert.ok(pkg.files.includes("extensions"));
  assert.ok(pkg.files.includes("vendor"), "the vendored runtime must be part of the published files");
  assert.ok(pkg.files.includes("LICENSE-APACHE-2.0"));
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /agent-stuff/);
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /howaboua/);
  assert.deepEqual(pkg.pi.themes, ["./themes/metis-pi.json"]);
  // Runtime dependencies are exactly: marked (the copy-provenance lexer must see the
  // host's token stream, pinned to the version pi-tui uses) plus the vendored
  // codex-conversion's own runtime deps, declared so pi installs them for the git
  // clone (see vendor/pi-codex-conversion/package.json).
  assert.equal(pkg.dependencies.marked, load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked);
  const vendored = load("vendor/pi-codex-conversion/package.json").dependencies;
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["marked", ...Object.keys(vendored)].sort());
  for (const [name, range] of Object.entries(vendored)) assert.equal(pkg.dependencies[name], range, `${name} must match the vendored manifest`);
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.pi.prompts, undefined);
});

test("metis-pi owns vendored updates without an upstream npm check", () => {
  // vendor:fresh owns generated output; the real AgentSession test owns initialization.
  const root = new URL("../vendor/pi-codex-conversion/src/", import.meta.url);
  for (const path of readdirSync(root, { recursive: true })) {
    if (!/\.(ts|js)$/.test(path)) continue;
    const text = readFileSync(new URL(path, root), "utf8");
    assert.doesNotMatch(`${path}\n${text}`, /maybeWarnLocalCheckoutVersion|local-version-warning|registry\.npmjs\.org|local checkout is behind npm/, path);
  }
});

test("display runtime has no registration, result mutation or tool activation; chrome APIs are the only UI surface", () => {
  const rootUrl = new URL("../src/", import.meta.url);
  // Node owns recursion; todo owns non-display tools and commands. Only the
  // interaction summary may append entries to the session from display code.
  const forbidden = /\b(?:registerTool|setActiveTools|sendMessage|sendUserMessage|setSystemPrompt|registerShortcut|setTheme)\s*\(/;
  const appendEntryRe = /\bappendEntry\s*\(/;
  for (const file of readdirSync(rootUrl, { recursive: true })) {
    if (!/\.(ts|mjs)$/.test(file) || /^todo[\\/]/.test(file)) continue;
    const text = readFileSync(new URL(file, rootUrl), "utf8");
    assert.doesNotMatch(text, forbidden, file);
    if (file !== "turn-summary.ts") assert.doesNotMatch(text, appendEntryRe, file);
    assert.doesNotMatch(text, /\.on\(\s*["'](?:tool_result|tool_call|context|before_agent_start)["']/);
  }
});
