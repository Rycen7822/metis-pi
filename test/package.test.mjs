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

test("package exposes extensions, themes and portable skills with their references", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/*.ts"]);
  const packed = Object.values(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
  })))[0];
  const files = new Set(packed.files.map(({ path }) => path));
  for (const name of ["config", "appearance", "goal", "condense", "dynamic-agents"]) {
    assert.ok(files.has(`extensions/${name}.ts`), name);
  }
  for (const path of [
    "CHANGELOG.md", "metis-pi.toml", "metis-pi-config.md", "vendor/tree-sitter-bash/tree-sitter-bash.wasm",
    "skills/ast-grep/SKILL.md", "skills/ast-grep/references/rule_reference.md",
    "assets/native-tools/exec/linux-x64/exec_bridge",
    "assets/native-tools/view-image/linux-x64/view_image",
    "docs/provenance/execution/LICENSE", "docs/provenance/execution/README.md", "docs/provenance/condense/LICENSE",
  ]) assert.ok(files.has(path), path);
  for (const path of ["LICENSE", "LICENSE-APACHE-2.0", "NOTICE", "themes/metis-pi.json"]) assert.ok(files.has(path), path);
  assert.ok(files.has("extensions/execution.ts"));
  assert.ok(files.has("src/condense/runtime.ts"));
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /agent-stuff/);
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /howaboua/);
  assert.deepEqual(pkg.pi.themes, ["./themes/metis-pi.json"]);
  // The copy-provenance lexer must see the same token stream as the host.
  assert.equal(pkg.dependencies.marked, load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal(pkg.pi.prompts, undefined);
});
