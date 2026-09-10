import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("theme removes tool backgrounds through the supported palette mechanism", () => {
  const theme = load("themes/codex-appearance.json");
  assert.equal(theme.name, "codex-appearance");
  for (const key of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) assert.equal(theme.colors[key], "");
  for (const value of Object.values(theme.colors)) {
    assert.ok(value === "" || /^#[0-9a-f]{6}$/i.test(value) || Object.hasOwn(theme.vars, value));
  }
  for (const key of ["toolTitle", "toolOutput", "thinkingMax", "scrollbarThumb", "searchMatchBg", "bashMode", "mdCode"]) {
    assert.ok(Object.hasOwn(theme.colors, key));
  }
});

test("package defaults to the compact transcript entry, with no added runtime dependencies", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
  assert.equal(existsSync(new URL("../index.ts", import.meta.url)), true);
  assert.equal(existsSync(new URL("../extensions", import.meta.url)), false);
  assert.deepEqual(pkg.pi.themes, ["./themes/codex-appearance.json"]);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.pi.prompts, undefined);
});

test("runtime has no registration, result mutation, tool activation or global UI takeover calls", () => {
  const files = ["index.ts", ...readdirSync(new URL("../src", import.meta.url)).map((name) => `src/${name}`)];
  const forbidden = /\b(?:registerTool|setActiveTools|sendMessage|sendUserMessage|appendEntry|setSystemPrompt|setEditorComponent|setFooter|setHeader|setWorkingMessage|registerShortcut|setTheme)\s*\(/;
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, forbidden, file);
    assert.doesNotMatch(text, /\.on\(\s*["'](?:tool_result|tool_call|context|before_agent_start)["']/);
  }
});
