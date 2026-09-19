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

test("user messages regain the Codex gray surface through the native theme slot", () => {
  const theme = load("themes/codex-appearance.json");
  // 0.9.2: userMessageBg resolves to a non-empty low-contrast surface via a
  // vars entry (the host's UserMessageComponent paints it through a Box).
  assert.equal(theme.colors.userMessageBg, "userMessageSurface");
  assert.match(theme.vars.userMessageSurface, /^#[0-9a-f]{6}$/i);
  assert.notEqual(theme.vars.userMessageSurface.toLowerCase(), "#000000");
});

test("package defaults to the compact transcript entry, with no added runtime dependencies", () => {
  const pkg = load("package.json");
  assert.deepEqual(pkg.pi.extensions, ["./extensions/*.ts"]);
  assert.equal(existsSync(new URL("../extensions/appearance.ts", import.meta.url)), true);
  assert.equal(existsSync(new URL("../extensions/goal.ts", import.meta.url)), true);
  // goal.ts is vendored from an Apache-2.0 upstream, so its licence text and
  // attribution must ship with the package.
  assert.equal(existsSync(new URL("../LICENSE-APACHE-2.0", import.meta.url)), true);
  assert.ok(pkg.files.includes("extensions"));
  assert.ok(pkg.files.includes("LICENSE-APACHE-2.0"));
  assert.match(readFileSync(new URL("../NOTICE", import.meta.url), "utf8"), /agent-stuff/);
  assert.deepEqual(pkg.pi.themes, ["./themes/codex-appearance.json"]);
  // The ONE allowed runtime dependency: marked, pinned to the exact version
  // pi-tui itself uses (the copy-provenance lexer must see the host's token
  // stream). Any other dependency, or a version drift against pi-tui, fails.
  assert.deepEqual(pkg.dependencies, { marked: load("node_modules/@earendil-works/pi-tui/package.json").dependencies.marked });
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.pi.prompts, undefined);
});

test("display runtime has no registration, result mutation or tool activation; chrome APIs are the only UI surface", () => {
  const rootUrl = new URL("../src/", import.meta.url);
  const files = [];
  const walk = (url, prefix) => {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === "todo") continue; // codex-todo subsystem (non-display)
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, url), `${path}/`);
      else if (/\.(ts|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  walk(rootUrl, "src/");
  // Scope: the codex-appearance display runtime only (src/** minus src/todo/).
  // goal.ts (extensions/goal.ts) is the one deliberate non-display entry — it
  // registers /goal, the goal tools and the session/context hooks those
  // features need — and is covered by goal.test.mts. src/todo/ is the
  // codex-todo subsystem (extensions/todo.ts entry): it OWNS tool/command/
  // shortcut registration and is covered by test/todo-*.test.mts. Every other
  // file stays display-only.
  //
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
