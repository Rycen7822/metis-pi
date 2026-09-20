// config.test.mts — namespaced config loading with SAFE defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config.ts";

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

test("top-level enabled=false is the kill switch", () => {
  const { config } = loadConfig("/agent", () => JSON.stringify({ enabled: false }));
  assert.equal(config.enabled, false);
});

