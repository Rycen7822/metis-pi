import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

test("package exposes display, goal, todo, condense, dynamic-agents and codex entries", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/*.ts", "./src/codex/extension.ts"]);
  const packed = Object.values(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  })))[0];
  const files = new Set(packed.files.map(({ path }) => path));
  for (const name of ["appearance", "goal", "todo", "condense", "dynamic-agents"]) {
    assert.ok(files.has(`extensions/${name}.ts`), name);
  }
  for (const path of ["package.json", "dist/index.js", "LICENSE", "UPSTREAM.md", "PATCHES.md"]) {
    assert.ok(files.has(`vendor/pi-condense/${path}`), `pi-condense/${path}`);
  }
  for (const path of [
    "src/changelog.ts", "CHANGELOG.md", "vendor/tree-sitter-bash/tree-sitter-bash.wasm",
    "vendor/js-tiktoken/ranks/o200k_base.js", "src/codex/execution/code-mode/CUSTOM-TOOLS.md",
    "assets/native-tools/exec/linux-x64/exec_bridge", "assets/native-tools/apply-patch/linux-x64/apply_patch",
    "assets/native-tools/view-image/linux-x64/view_image", "native/code-mode-host/NOTICE",
    "docs/provenance/codex-conversion/LICENSE", "docs/provenance/codex-conversion/UPSTREAM.md",
    "docs/provenance/codex-conversion/PATCHES.md",
  ]) assert.ok(files.has(path), path);
  for (const path of ["LICENSE", "LICENSE-APACHE-2.0", "NOTICE", "themes/metis-pi.json"]) assert.ok(files.has(path), path);
  assert.ok(files.has("src/codex/extension.ts"));
  assert.ok(files.has("vendor/pi-condense/index.ts"));
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /agent-stuff/);
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /howaboua/);
  assert.deepEqual(pkg.pi.themes, ["./themes/metis-pi.json"]);
  // The copy-provenance lexer must see the same token stream as the host.
  assert.equal(pkg.dependencies.marked, load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked);
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.pi.prompts, undefined);
});
