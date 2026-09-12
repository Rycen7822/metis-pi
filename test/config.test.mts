// config.test.mts — namespaced config loading with SAFE defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.ts";

test("missing file yields defaults", () => {
  const { config, problems } = loadConfig(undefined, () => undefined);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 0);
});

test("partial file merges over defaults; unknown keys are ignored", () => {
  const { config, problems } = loadConfig(
    "/agent",
    (p) => (p === "/agent/codex-appearance.json" ? JSON.stringify({ thinking: { rail: false } }) : undefined),
  );
  assert.equal(config.thinking.rail, false);
  assert.equal(config.thinking.autoCollapse, DEFAULT_CONFIG.thinking.autoCollapse);
  assert.equal(problems.length, 0);
});

test("malformed JSON is reported and defaults are used", () => {
  const { config, problems } = loadConfig("/agent", () => "{ not json");
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /JSON parse failed/);
});

test("invalid values fall back per-field with a warning", () => {
  const { config, problems } = loadConfig(
    "/agent",
    () => JSON.stringify({ thinking: { autoCollapse: "yes-please" }, summary: { persist: 42 } }),
  );
  assert.equal(config.thinking.autoCollapse, DEFAULT_CONFIG.thinking.autoCollapse);
  assert.equal(config.summary.persist, DEFAULT_CONFIG.summary.persist);
  assert.equal(problems.length, 1);
});

test("top-level enabled=false is the kill switch", () => {
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

test("fullscreen margin: valid values accepted, out-of-range clamped to defaults", () => {
  const ok = loadConfig("/agent", () => JSON.stringify({ fullscreen: { marginX: 3, minWidth: 100 } }));
  assert.equal(ok.config.fullscreen.marginX, 3);
  assert.equal(ok.config.fullscreen.minWidth, 100);
  assert.equal(ok.problems.length, 0);
  const bad = loadConfig("/agent", () => JSON.stringify({ fullscreen: { marginX: 99, minWidth: 3 } }));
  assert.equal(bad.config.fullscreen.marginX, DEFAULT_CONFIG.fullscreen.marginX);
  assert.equal(bad.config.fullscreen.minWidth, DEFAULT_CONFIG.fullscreen.minWidth);
  assert.equal(bad.problems.length, 2);
  const zero = loadConfig("/agent", () => JSON.stringify({ fullscreen: { marginX: 0 } }));
  assert.equal(zero.config.fullscreen.marginX, 0, "marginX 0 is a valid disable");
  assert.equal(zero.problems.length, 0);
});
