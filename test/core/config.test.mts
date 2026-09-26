// config.test.mts — namespaced config loading with SAFE defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config.ts";

test("missing file yields defaults", () => {
  const { config, problems } = loadConfig(undefined, () => undefined);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 0);
});

test("partial settings merge over defaults while obsolete quota fields are ignored", () => {
  const source = JSON.stringify({
    thinking: { rail: false }, footer: { showCodexQuota: true },
    quota: { codex: "on", refreshSeconds: 30 },
  });
  const { config, problems } = loadConfig("/agent", (p) => p === "/agent/metis-pi.json" ? source : undefined);
  assert.equal(config.thinking.rail, false);
  assert.equal(config.thinking.completed, DEFAULT_CONFIG.thinking.completed);
  assert.equal("showCodexQuota" in config.footer, false);
  assert.equal("quota" in config, false);
  assert.deepEqual(problems, []);
});

test("malformed JSON is reported and defaults are used", () => {
  const { config, problems } = loadConfig("/agent", () => "{ not json");
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /JSON parse failed/);
});

test("numeric options preserve clamp versus reject boundaries", () => {
  for (const [section, key, min, max, clamps] of [
    ["thinking", "peekLines", 1, 40, true],
    ["working", "animationIntervalMs", 32, 1000, true],
    ["writePreview", "rows", 0, 64, false],
    ["fullscreen", "marginX", 0, 8, false],
    ["fullscreen", "minWidth", 40, 400, false],
  ] as const) {
    const fallback = (DEFAULT_CONFIG[section] as Record<string, unknown>)[key];
    for (const [value, expected, errors] of [
      [null, fallback, 0], ["3", fallback, 1],
      [min, min, 0], [max, max, 0], [min + 0.9, min, 0],
      [min - 1, clamps ? min : fallback, clamps ? 0 : 1],
      [max + 1, clamps ? max : fallback, clamps ? 0 : 1],
    ]) {
      const { config, problems } = loadConfig("/agent", () => JSON.stringify({ [section]: { [key]: value } }));
      assert.equal((config[section] as Record<string, unknown>)[key], expected, `${section}.${key}=${value}`);
      assert.equal(problems.length, errors);
    }
  }
});

test("invalid sections and fields report actual defaults without sharing mutable defaults", () => {
  const loaded = loadConfig("/agent", () => JSON.stringify({
    thinking: { completed: "invalid", rail: "false" },
    composer: false,
    footer: { enabled: false, details: null, unknown: true },
    glyphs: { include: ["★", "★", "😀", "ascii", 4] },
  }));
  assert.equal(loaded.config.thinking.completed, "collapsed");
  assert.deepEqual(loaded.config.composer, DEFAULT_CONFIG.composer);
  assert.deepEqual(loaded.config.footer, { ...DEFAULT_CONFIG.footer, enabled: false });
  assert.deepEqual(loaded.config.glyphs.include, ["★", "😀"]);
  assert.equal(loaded.problems.length, 5);
  assert.match(loaded.problems[0]!, /using "collapsed"/);
  assert.match(loaded.problems[1]!, /thinking.rail: expected boolean/);
  loaded.config.glyphs.include.push("✓");
  assert.deepEqual(loadConfig(undefined).config.glyphs.include, []);
});
