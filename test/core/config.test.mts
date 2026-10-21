import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, DEFAULT_CONFIG } from "../../src/appearance-config.ts";
import {
  readMetisConfig, updateMetisConfig, parseMetisConfig, defaultMetisConfig, renderMetisConfig,
  initializeMetisConfig, isMetisConfigTable,
  readWebAccessConfig, updateWebAccessConfig,
} from "../../src/metis-config.ts";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "smol-toml";
const tomlReader = (text: string) => (path: string) => path.endsWith("metis-pi.toml") ? text : undefined;
function table(value: unknown): Record<string, unknown> {
  assert.ok(isMetisConfigTable(value), "expected a configuration table");
  return value;
}

test("web credentials remain outside TOML and preference updates never rewrite them", (t) => {
  const dir = mkdtempSync(join(process.cwd(), ".work", "web-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const jsonPath = join(dir, "web-search.json"), tomlPath = join(dir, "metis-pi.toml");
  const credentials = {
    openaiApiKey: "$METIS_TEST_OPENAI_KEY", tinyfishApiKey: "!printf synthetic-key",
    degoogHeaders: { Authorization: "Bearer synthetic-token" }, proxy: "http://user:synthetic-password@localhost:8080",
  };
  const original = JSON.stringify({ ...credentials, provider: "brave", workflow: "auto-summary", pdf: { enabled: false } });
  writeFileSync(jsonPath, original);
  assert.equal(initializeMetisConfig(dir).created, true);
  assert.equal(readFileSync(jsonPath, "utf8"), original);
  assert.equal(readWebAccessConfig(dir)["openaiApiKey"], credentials.openaiApiKey);
  assert.doesNotMatch(readFileSync(tomlPath, "utf8"), /METIS_TEST_OPENAI_KEY|synthetic-(key|token|password)|openaiApiKey|degoogHeaders/);
  updateMetisConfig(dir, { sessionRecall: { queryModel: "openai/recall" } });
  updateWebAccessConfig(dir, { provider: "exa", workflow: "none" });
  assert.equal(readWebAccessConfig(dir)["provider"], "exa");
  assert.equal(table(readMetisConfig(dir).config["sessionRecall"])["queryModel"], "openai/recall");
  assert.equal(readFileSync(jsonPath, "utf8"), original);
  assert.throws(() => updateWebAccessConfig(dir, { openaiApiKey: "synthetic-key" }), /web-search.json/);
  const mixed = JSON.stringify({ ...credentials, provider: "brave", workflow: "auto-summary" });
  writeFileSync(jsonPath, mixed);
  updateMetisConfig(dir, { appearance: { enabled: false } });
  assert.equal(readFileSync(jsonPath, "utf8"), mixed);
  assert.equal(readWebAccessConfig(dir)["provider"], "exa");
  assert.equal(readWebAccessConfig(dir)["workflow"], "none");
  writeFileSync(tomlPath, '[webAccess]\nopenaiApiKey="synthetic-key"\n');
  assert.throws(() => readWebAccessConfig(dir), /credentials belong in web-search.json/);
});

test("missing file yields defaults", () => {
  const { config, problems } = loadConfig(undefined, () => undefined);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 0);
});

test("footer disclosure TOML booleans default to folded and reject non-booleans", () => {
  const defaults = loadConfig(undefined).config.footer;
  assert.equal(defaults.locationExpanded, false);
  assert.equal(defaults.pruneExpanded, false);
  const loaded = loadConfig("/agent", path => path.endsWith("metis-pi.toml")
    ? '[appearance.footer]\nlocationExpanded=true\npruneExpanded="yes"\n' : undefined);
  assert.equal(loaded.config.footer.locationExpanded, true);
  assert.equal(loaded.config.footer.pruneExpanded, false);
  assert.deepEqual(loaded.problems, ["footer.pruneExpanded: expected boolean, got string — using false"]);
});

test("partial appearance settings merge over defaults", () => {
  const source = stringify({ appearance: { thinking: { rail: false } } });
  const { config, problems } = loadConfig("/agent", tomlReader(source));
  assert.equal(config.thinking.rail, false);
  assert.equal(config.thinking.completed, DEFAULT_CONFIG.thinking.completed);
  assert.deepEqual(problems, []);
});

test("malformed TOML is reported and defaults are used", () => {
  const { config, problems } = loadConfig("/agent", tomlReader("[broken"));
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /invalid TOML/);
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
      [undefined, fallback, 0], ["3", fallback, 1],
      [min, min, 0], [max, max, 0], [min + 0.9, min, 0],
      [min - 1, clamps ? min : fallback, clamps ? 0 : 1],
      [max + 1, clamps ? max : fallback, clamps ? 0 : 1],
    ]) {
      const { config, problems } = loadConfig("/agent", tomlReader(stringify({ appearance: { [section]: { [key]: value } } })));
      assert.equal((config[section] as Record<string, unknown>)[key], expected, `${section}.${key}=${value}`);
      assert.equal(problems.length, errors);
    }
  }
});

test("invalid sections and fields report actual defaults without sharing mutable defaults", () => {
  const loaded = loadConfig("/agent", tomlReader(stringify({ appearance: {
    thinking: { completed: "invalid", rail: "false" },
    composer: false,
    footer: { enabled: false, unknown: true },
    glyphs: { include: ["★", "★", "😀", "ascii", 4] },
  } })));
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

test("readable rendering retains default annotations without changing serialized values", () => {
  const config = defaultMetisConfig();
  table(table(config.appearance).thinking).peekLines = 17;
  table(config.dynamicAgents).groups = [{ id: "example", file: "AGENTS.md", include: ["p/*"], exclude: [] }];
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
  table(table(initialConfig.execution).tools).autoReasoning = true;
  writeFileSync(path, renderMetisConfig(initialConfig) + '\n[futureDate]\nday=2026-10-08\nclock=12:30:00\n');
  updateMetisConfig(dir, { future: { opaque: [1, 2] }, execution: { ui: { toolRenaming: false } } });
  updateMetisConfig(dir, { contextPrune: { minBatchChars: 1234 } });
  const config = readMetisConfig(dir).config;
  assert.deepEqual(table(config.future).opaque, [1, 2]);
  assert.equal(table(table(config.execution).ui).toolRenaming, false);
  assert.equal(table(table(config.execution).tools).autoReasoning, true);
  assert.equal(table(config.contextPrune).minBatchChars, 1234);
  assert.match(readFileSync(path, "utf8"), /# 5a\. 高级摘要预算/);
  assert.match(readFileSync(path, "utf8"), /day = 2026-10-08\n/);
  assert.match(readFileSync(path, "utf8"), /clock = 12:30:00(?:\.0+)?\n/);
  writeFileSync(path, "[broken");
  assert.throws(() => updateMetisConfig(dir, { appearance: { enabled: true } }), /invalid TOML/);
  assert.equal(readFileSync(path, "utf8"), "[broken");
});

test("initialization leaves existing TOML preferences unchanged", t => {
  mkdirSync(".work", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".work/metis-recall-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "metis-pi.toml");
  assert.equal(readMetisConfig(dir).present, false);
  assert.equal(initializeMetisConfig(dir).created, true);
  assert.equal(readMetisConfig(dir).present, true);
  for (const selection of [undefined, "openai/current-choice", "default"]) {
    const original = selection === undefined ? "" : stringify({ sessionRecall: { queryModel: selection } });
    writeFileSync(configPath, original);
    assert.equal(table(readMetisConfig(dir).config.sessionRecall).queryModel, selection ?? "default");
    assert.equal(initializeMetisConfig(dir).created, false);
    assert.equal(table(readMetisConfig(dir).config.sessionRecall).queryModel, selection ?? "default");
    assert.equal(readFileSync(configPath, "utf8"), original);
  }
});
