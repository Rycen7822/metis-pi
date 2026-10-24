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
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const windows = process.platform === "win32";
  const packed = Object.values(JSON.parse(execFileSync(windows ? process.env.ComSpec || "cmd.exe" : "npm",
    windows ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args, {
      cwd: new URL("..", import.meta.url), encoding: "utf8", windowsHide: true,
    })))[0];
  const files = new Set(packed.files.map(({ path }) => path));
  for (const name of ["config", "appearance", "goal", "condense", "dynamic-agents", "web-access", "session-recall", "lsp", "ask-user-question", "btw"]) {
    assert.ok(files.has(`extensions/${name}.ts`), name);
  }
  for (const path of [
    "CHANGELOG.md", "metis-pi.toml", "metis-pi-config.md", "vendor/tree-sitter-bash/tree-sitter-bash.wasm",
    "skills/ast-grep/SKILL.md", "skills/ast-grep/references/rule_reference.md",
    "skills/commit/SKILL.md", "skills/github/SKILL.md", "skills/uv/SKILL.md", "src/btw/runtime.ts",
    "assets/native-tools/exec/linux-x64/exec_bridge",
    "assets/native-tools/exec/win32-x64/exec_bridge.exe", "assets/native-tools/win32-x64-manifest.json",
    "docs/provenance/execution/LICENSE", "docs/provenance/execution/README.md", "docs/provenance/condense/LICENSE",
    "src/pi-web-access/index.ts", "src/pi-web-access/dist/index.js", "src/pi-web-access/dist/mcp-cli.js",
    "src/appearance/runtime.ts", "src/presentation/renderers.ts",
    "src/presentation/components/tool-components.ts", "src/presentation/components/transcript-components.ts",
    "src/configuration/store.ts", "src/configuration/web-access.ts",
    "src/remote-compaction/runtime.ts", "src/remote-compaction/checkpoint.ts",
    "src/skills/host-patch.ts", "src/extension-paths.ts",
    "src/pi-web-access/LICENSE", "src/pi-session-recall/session-recall.ts", "src/pi-session-recall/LICENSE",
    "src/pi-lsp/config.ts", "src/pi-lsp/pi-lsp.ts", "src/pi-lsp/code-actions.ts", "src/pi-lsp/published-diagnostics.ts", "src/pi-lsp/LICENSE", "src/pi-lsp/METIS.md", "docs/features/lsp.md",
    "src/ask-user-question/index.ts", "src/ask-user-question/ask-user-question.ts", "src/ask-user-question/LICENSE", "src/ask-user-question/METIS.md",
    "src/ask-user-question/locales/en.json", "docs/features/ask-user-question.md",
    "src/pi-web-access/licenses/typebox.LICENSE",
    "src/neural-search/native/binding/ffi.ts", "src/neural-search/LICENSE",
    "src/neural-search/assets/linux-x64/libmetis_neural_search.so",
    "src/neural-search/assets/win32-x64/metis_neural_search.dll", "src/neural-search/assets/win32-x64-manifest.json",
    "src/neural-search/assets/THIRD_PARTY_NOTICES.txt", "src/neural-search/assets/THIRD_PARTY_NOTICES-win32-x64.txt",
    "src/neural-search/assets/RUST-STDLIB-NOTICES.html",
  ]) assert.ok(files.has(path), path);
  assert.ok([...files].every((path) => !path.startsWith("references/")));
  for (const path of files) {
    if (!path.startsWith("src/")) continue;
    assert.ok(!path.startsWith("src/neural-search/engine/"), path);
    assert.ok(!path.split("/").some(part => ["test", "scripts", "evidence"].includes(part)), path);
    assert.doesNotMatch(path, /(?:^|\/)(?:AGENTS\.md|tsconfig[^/]*\.json|test-fixtures\.ts)$|\.test\.[^/]+$/, path);
  }
  assert.ok(!Object.hasOwn(pkg.dependencies, "@juicesharp/rpiv-ask-user-question"));
  assert.ok(!Object.hasOwn(pkg.dependencies, "@juicesharp/rpiv-config"));
  assert.ok([...files].every((path) => !path.split("/").includes("node_modules")));
  for (const path of ["LICENSE", "LICENSE-APACHE-2.0", "NOTICE", "themes/metis-pi.json"]) assert.ok(files.has(path), path);
  assert.ok(files.has("extensions/execution.ts"));
  assert.ok(files.has("src/condense/runtime.ts"));
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /agent-stuff/);
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /howaboua/);
  assert.deepEqual(pkg.pi.themes, ["./themes/metis-pi.json"]);
  // The copy-provenance lexer must see the same token stream as the host.
  assert.equal(pkg.dependencies.marked, load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked);
  assert.equal(pkg.dependencies["marked-cjk-friendly"], load("node_modules/@earendil-works/pi-tui/package.json").dependencies["marked-cjk-friendly"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal(pkg.pi.prompts, undefined);
});
