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
  // The ONE allowed runtime dependency: marked, pinned to the exact version
  // pi-tui itself uses (the copy-provenance lexer must see the host's token
  // stream). Any other dependency, or a version drift against pi-tui, fails.
  assert.deepEqual(pkg.dependencies, { marked: load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked });
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.pi.prompts, undefined);
});

test("runtime has no registration, result mutation or tool activation; chrome APIs are the only UI surface", () => {
  const rootUrl = new URL("../src", import.meta.url);
  const files = ["index.ts"];
  const walk = (url, prefix) => {
    for (const name of readdirSync(url)) {
      if (name.endsWith(".ts") || name.endsWith(".mjs")) files.push(`${prefix}${name}`);
      else {
        try {
          walk(new URL(`${name}/`, url), `${prefix}${name}/`);
        } catch { /* not a directory */ }
      }
    }
  };
  walk(rootUrl, "src/");
  // appendEntry is allowed ONLY in turn-summary.ts (the audited persistence
  // exception). Everything else stays forbidden everywhere.
  const forbidden = /\b(?:registerTool|setActiveTools|sendMessage|sendUserMessage|setSystemPrompt|registerShortcut|setTheme)\s*\(/;
  const appendEntryRe = /\bappendEntry\s*\(/;
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, forbidden, file);
    if (file !== "src/turn-summary.ts") assert.doesNotMatch(text, appendEntryRe, file);
    assert.doesNotMatch(text, /\.on\(\s*["'](?:tool_result|tool_call|context|before_agent_start)["']/);
  }
});
