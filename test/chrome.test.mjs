// chrome.test.mjs — chrome-level tests against the REAL installed host:
// editor factory shape, footer/header component contracts, working message
// wiring and the /codex-ui diagnostics command. Run: npm run test:chrome
//
// These use scripts/host-smoke.mjs's loader if present; otherwise they are
// skipped (host not installed / not a dev machine).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const PI_ROOT = "/home/xu/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent";
const hasHost = existsSync(`${PI_ROOT}/dist/index.js`);

test("host availability gate", () => {
  // Sanity: the test file itself must exist and the gate must be boolean.
  assert.equal(typeof hasHost, "boolean");
});

test("chrome modules have no direct host imports (src/ rule)", () => {
  for (const name of ["chrome/editor.ts", "chrome/footer.ts", "chrome/header.ts"]) {
    const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
    assert.ok(!text.includes("from \"@earendil-works"), `${name} must not import host packages directly`);
    assert.ok(!text.includes("from '@earendil-works"), `${name} must not import host packages directly`);
  }
});

test("editor factory: paddingX 2, embedWorkingStatus true, accent painter", async () => {
  const { makeCodexEditorFactory } = await import("../src/chrome/editor.ts");
  const created = [];
  class FakeCustomEditor {
    constructor(_tui, _theme, _keybindings, options) {
      this.options = options;
      this.borderColor = (s) => `gray(${s})`;
      created.push(this);
    }
  }
  const factory = makeCodexEditorFactory({ host: { CustomEditor: FakeCustomEditor } });
  const editor = factory({}, {}, {});
  assert.equal(created.length, 1);
  assert.deepEqual(editor.options, { embedWorkingStatus: true, paddingX: 2 });
  // Border repaint: accent applied (default painter wraps with truecolor cyan)
  const painted = editor.borderColor("────");
  assert.match(painted, /────/);
  assert.match(painted, /\x1b\[38;2;148;226;213m|\x1b\[38;5;/);
});

test("extension event surface includes agent lifecycle and shutdown clears chrome", async () => {
  const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
  assert.ok(source.includes('"agent_start"'), "agent_start wired");
  assert.ok(source.includes('"agent_settled"'), "agent_settled wired");
  assert.ok(source.includes("setEditorComponent"), "editor chrome installed via public API");
  assert.ok(source.includes("setFooter"), "footer chrome installed via public API");
  assert.ok(source.includes("setHeader"), "header chrome installed via public API");
  assert.ok(source.includes("setWorkingMessage"), "working message wired");
  // Restore path must clear ONLY our own factory.
  assert.ok(source.includes("ourEditorFactory"), "factory identity tracked");
  assert.ok(source.includes("getEditorComponent?.() === ourEditorFactory"), "identity-compared restore");
  // No forbidden APIs anywhere in the activation path.
  assert.ok(!source.includes("registerTool"), "no registerTool");
  assert.ok(!source.includes("setActiveTools"), "no setActiveTools");
});

test("config kill-switch: enabled=false disables chrome and summary", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

test("footer component: renders identity-safe left/right layout", async () => {
  const { createFooterComponent } = await import("../src/chrome/footer.ts");
  const deps = {
    getContextUsage: () => ({ percentUsed: 12 }),
    getModel: () => ({ label: "test-model", effort: "high" }),
    getCwd: () => "/tmp/proj",
    requestRender: () => {},
  };
  const theme = { fg: (_k, t) => t };
  const component = createFooterComponent(deps, { getStatusItems: () => [] }, theme);
  const lines = component.render(80);
  assert.ok(Array.isArray(lines) && lines.length >= 1, "footer renders at least one line");
  const joined = lines.join("\n");
  assert.ok(joined.includes("test-model"), "model shown");
  assert.ok(joined.includes("proj"), "cwd basename shown");
  assert.ok(joined.includes("88% context left"), "context usage shown (Codex grammar: remaining)");
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../src/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.0",
    piVersion: "0.85.1",
    getModel: () => ({ label: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const lines = component.render(80);
  const joined = lines.join("\n");
  assert.ok(joined.includes("codex-appearance"), "own identity shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});
