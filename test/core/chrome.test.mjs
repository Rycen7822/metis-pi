// Presentation rules run without activation, native editor or a Git repository.
import test from "node:test";
import assert from "node:assert/strict";
import { layoutFooter } from "../../src/chrome/footer.ts";

test("footer wraps ordered metadata into literal narrow and wide rows", () => {
  const snapshot = {
    model: { id: "gpt-6-sol", provider: "openai-codex", contextWindow: 272_000 },
    thinkingLevel: "xhigh",
    contextUsage: { tokens: 49_600, contextWindow: 272_000, percent: 18.2 },
    cwd: "/tmp/codex_workspace",
    session: { input: 106_000, output: 8_900, cacheRead: 851_000, cacheWrite: 0, costTotal: 0 },
    cacheLastPct: 99.9,
    revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const rows = (width, options = show) => layoutFooter(snapshot, options, width, "main")
    .map((row) => row.map((span) => span.text).join(""));
  const identity = "gpt-6-sol · xhigh · openai-codex";
  const context = "/tmp/codex_workspace (main) · ctx 49.6k/272k · 18.2%";
  const usage = "↑106k ↓8.9k · cache 99.9%";
  assert.deepEqual(rows(60), [identity, context, usage]);
  assert.deepEqual(rows(200), [`${identity} · ${context} · ${usage}`]);
  assert.deepEqual(rows(140, { ...show, metadata: false }), ["/tmp/codex_workspace (main) · ↑106k ↓8.9k · cache 99.9%"]);
  assert.deepEqual(layoutFooter(snapshot, show, 0, "main"), [], "0 columns: hidden, no crash");
  assert.deepEqual(layoutFooter(snapshot, show, 1, "main"), []);
  assert.deepEqual(layoutFooter(snapshot, show, 2, "main"), []);

});

test("footer keeps unknown context distinct from zero usage", () => {
  const snapshot = {
    model: { id: "m", provider: "p", contextWindow: 272_000 },
    thinkingLevel: undefined, contextUsage: { tokens: null, contextWindow: 272_000, percent: null },
    cwd: "/tmp/work", session: undefined, cacheLastPct: null, speed: undefined, changes: undefined, revision: 1,
  };
  const show = { metadata: true, details: true, showCache: true, showChanges: true, showSpeed: true };
  const text = (s) => layoutFooter(s, show, 100, undefined).flat().map((seg) => seg.text).join("");
  assert.match(text(snapshot), /ctx —\/272k/);
  assert.doesNotMatch(text(snapshot), /0%|↑0|cache/);
  assert.match(text({ ...snapshot, contextUsage: { tokens: 0, contextWindow: 272_000, percent: 0 } }), /ctx 0\/272k · 0%/);
});

test("header component: real identity, never impersonates OpenAI", async () => {
  const { createHeaderComponent } = await import("../../src/chrome/header.ts");
  const deps = {
    appearanceVersion: "0.8.5",
    piVersion: "0.85.1",
    getModel: () => ({ id: "test-model" }),
    getCwd: () => "/tmp/proj",
  };
  const component = createHeaderComponent(deps, { fg: (_k, t) => t });
  const joined = component.render(80).join("\n");
  assert.ok(joined.includes("metis-pi"), "own identity shown");
  assert.ok(joined.includes("test-model"), "real model id shown");
  assert.ok(!/OpenAI/i.test(joined), "never claims OpenAI");
});
