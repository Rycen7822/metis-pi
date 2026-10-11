import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config.ts";
import { readMetisConfig, updateMetisConfig, parseMetisConfig, defaultMetisConfig, renderMetisConfig } from "../../src/metis-config.ts";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
const legacyReader = (text: string) => (path: string) => path.endsWith("metis-pi.json") ? text : undefined;

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
  const { config, problems } = loadConfig("/agent", legacyReader("{ not json"));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /invalid legacy JSON/);
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
      const { config, problems } = loadConfig("/agent", legacyReader(JSON.stringify({ [section]: { [key]: value } })));
      assert.equal((config[section] as Record<string, unknown>)[key], expected, `${section}.${key}=${value}`);
      assert.equal(problems.length, errors);
    }
  }
});

test("invalid sections and fields report actual defaults without sharing mutable defaults", () => {
  const loaded = loadConfig("/agent", legacyReader(JSON.stringify({
    thinking: { completed: "invalid", rail: "false" },
    composer: false,
    footer: { enabled: false, details: null, unknown: true },
    glyphs: { include: ["★", "★", "😀", "ascii", 4] },
  })));
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

test("TOML is authoritative and malformed TOML never falls back to legacy", () => {
  const files: Record<string, string> = {
    "/agent/metis-pi.toml": "[appearance]\nenabled=false\n[appearance.thinking]\npeekLines=12\n",
    "/agent/metis-pi.json": '{"enabled":true,"footer":{"enabled":false}}',
  };
  const loaded = loadConfig("/agent", path => files[path]);
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.config.thinking.peekLines, 12);
  assert.equal(loaded.config.footer.enabled, true);
  files["/agent/metis-pi.toml"] = "[broken";
  assert.match(loadConfig("/agent", path => files[path]).problems[0]!, /invalid TOML/);
});

test("readable rendering retains default annotations without changing serialized values", () => {
  const config = defaultMetisConfig();
  config.appearance.thinking.peekLines = 17;
  config.dynamicAgents.groups = [{ id: "example", file: "AGENTS.md", include: ["p/*"], exclude: [] }];
  config.future = { text: '[appearance]\nenabled = false\n# not a config comment', "quoted.key": '"quoted" # value',
    mixed: [1, { nested: true }], date: parseMetisConfig("value = 2026-10-08").value };
  config["quoted table"] = { enabled: true };
  const rendered = renderMetisConfig(config);
  assert.deepEqual(parseMetisConfig(rendered), parseMetisConfig(stringify(config)));
  assert.match(rendered, /# 1\. 显示界面 \/ Appearance/);
  assert.match(rendered, /# 5a\. 高级摘要预算/);
  assert.match(rendered, /peek 窗口行数.*\nrail = true\npeekLines = 17/);
  assert.match(rendered, /\[\[dynamicAgents.groups\]\]/);
});

test("global saves retain defaults, annotations, unknown fields and other owners", t => {
  mkdirSync(".work", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".work/metis-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "metis-pi.toml"), initialConfig = defaultMetisConfig();
  initialConfig.execution.tools.viewImageFallback = true;
  writeFileSync(path, renderMetisConfig(initialConfig) + '\n[futureDate]\nday=2026-10-08\nclock=12:30:00\n');
  updateMetisConfig(dir, { future: { opaque: [1, 2] }, execution: { ui: { toolRenaming: false } } });
  updateMetisConfig(dir, { contextPrune: { minBatchChars: 1234 } });
  const config = readMetisConfig(dir).config;
  assert.deepEqual(config.future.opaque, [1, 2]);
  assert.equal(config.execution.ui.toolRenaming, false);
  assert.equal(config.execution.tools.viewImageFallback, true);
  assert.equal(config.contextPrune.minBatchChars, 1234);
  assert.match(readFileSync(path, "utf8"), /# 5a\. 高级摘要预算/);
  assert.match(readFileSync(path, "utf8"), /day = 2026-10-08\n/);
  assert.match(readFileSync(path, "utf8"), /clock = 12:30:00(?:\.0+)?\n/);
  writeFileSync(path, "[broken");
  assert.throws(() => updateMetisConfig(dir, { appearance: { enabled: true } }), /invalid TOML/);
  assert.equal(readFileSync(path, "utf8"), "[broken");
});
