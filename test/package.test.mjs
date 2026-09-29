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

test("package exposes display, goal, todo, condense, dynamic-agents and codex-conversion entries", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/*.ts", "./vendor/pi-codex-conversion/dist/index.js"]);
  const packed = Object.values(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  })))[0];
  const files = new Set(packed.files.map(({ path }) => path));
  for (const name of ["appearance", "goal", "todo", "condense", "dynamic-agents"]) {
    assert.ok(files.has(`extensions/${name}.ts`), name);
  }
  for (const name of ["pi-codex-conversion", "pi-condense"]) {
    for (const path of ["package.json", "dist/index.js", "LICENSE", "UPSTREAM.md", "PATCHES.md"]) {
      assert.ok(files.has(`vendor/${name}/${path}`), `${name}/${path}`);
    }
  }
  for (const path of [
    "changelog.js", "CHANGELOG.md", "vendor/tree-sitter-bash/tree-sitter-bash.wasm",
    "vendor/js-tiktoken/ranks/o200k_base.js", "src/tools/code-mode/CUSTOM-TOOLS.md",
    "src/tools/exec/bin/linux-x64/exec_bridge", "src/tools/apply-patch/bin/linux-x64/apply_patch",
    "src/tools/view-image/bin/linux-x64/view_image", "code-mode/vendor/code-mode-src/NOTICE",
  ]) assert.ok(files.has(`vendor/pi-codex-conversion/${path}`), path);
  for (const path of ["LICENSE", "LICENSE-APACHE-2.0", "NOTICE", "themes/metis-pi.json"]) assert.ok(files.has(path), path);
  assert.ok(files.has("vendor/pi-codex-conversion/src/index.ts"));
  assert.ok(files.has("vendor/pi-condense/index.ts"));
  assert.ok(files.has("vendor/pi-codex-conversion/changelog.ts"));
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
