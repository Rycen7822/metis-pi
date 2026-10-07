import assert from "node:assert/strict";
import test from "node:test";
import { SettingsList } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { openPrunerSettings } from "../../src/condense/settings.ts";
import { registerCommands } from "../../src/condense/commands.ts";
import { ToolCallIndexer } from "../../src/condense/indexer.ts";
import { DEFAULT_CONFIG } from "../../src/condense/types.ts";
import { loadConfig, saveConfig } from "../../src/condense/config.ts";
import { parseMetisConfig } from "../../src/metis-config.ts";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

test("partial chain settings keep defaults, accept zero window and reject invalid fields", async () => {
  mkdirSync(".work", { recursive: true });
  const dir = mkdtempSync(join(process.cwd(), ".work/condense-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    for (const [given, expected] of [[{ enabled: true }, { enabled: true }],
      [{ rollingWindow: 0, fuseRangeSummary: false }, { rollingWindow: 0, fuseRangeSummary: false }],
      [{ enabled: "yes", rollingWindow: -1 }, {}], [null, {}]]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { chainCompression: given } }));
      assert.deepEqual((await loadConfig()).chainCompression, { ...DEFAULT_CONFIG.chainCompression, ...expected });
    }
    assert.equal(DEFAULT_CONFIG.minBatchChars, 5000);
    assert.equal(DEFAULT_CONFIG.autoBudgetThreshold, 0.7);
    assert.equal(DEFAULT_CONFIG.enabled, false);
    assert.equal(DEFAULT_CONFIG.opportunisticCompaction, false);
    for (const [value, expected] of [[undefined, 0.7], [null, null], [0.5, 0.5], [2, 0.7], ["bad", 0.7]]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { autoBudgetThreshold: value } }));
      assert.equal((await loadConfig()).autoBudgetThreshold, expected);
    }
    for (const value of [0, 8192, -1, 1.5, "8192", null, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { compactionSummaryMaxTokens: value } }));
      assert.equal((await loadConfig()).compactionSummaryMaxTokens, Number.isSafeInteger(value) && value >= 0 ? value : 0);
    }
    const before = readFileSync(join(dir, "settings.json"), "utf8");
    const path = join(dir, "metis-pi.toml");
    writeFileSync(path, '[contextPrune]\nautoBudgetThreshold=false\nbudgetTurnDelta=false\n[contextPrune.summaryBudget]\nminGainTokens=512\nminGainFraction=0.1\nmaxProxyTokens=1000\nnativeTargetTokens=0\ngrowthHeadroomTokens=-1\n');
    const config = await loadConfig();
    assert.equal(config.autoBudgetThreshold, null);
    assert.equal(config.budgetTurnDelta, null);
    assert.equal(config.summaryBudget.minGainTokens, 512);
    assert.equal(config.summaryBudget.maxProxyTokens, 1000);
    assert.equal(config.summaryBudget.nativeTargetTokens, 0);
    assert.equal(config.summaryBudget.growthHeadroomTokens, 16384);
    await saveConfig(config);
    assert.equal(parseMetisConfig(readFileSync(path, "utf8")).contextPrune.autoBudgetThreshold, false);
    assert.equal((await loadConfig()).autoBudgetThreshold, null);
    assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), before);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Opens the real overlay and hands back its row list plus the save/refresh recorders. */
async function openSettings(overrides = {}) {
  initTheme("dark", false);
  const current = { value: { ...structuredClone(DEFAULT_CONFIG), ...overrides } };
  const saved = [];
  const refreshed = [];
  let list;
  const ctx = {
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: () => {},
      custom: async (factory) => { list = factory(null, null, null, () => {}).children.find(child => child instanceof SettingsList); },
    },
  };
  await openPrunerSettings(ctx, current, async (value) => { saved.push(value); }, (value) => { refreshed.push(value); });
  return { current, saved, refreshed, list, row: (id) => list.items.find((item) => item.id === id) };
}

/** persistConfig saves asynchronously; let the pending microtask run. */
const flushSaves = () => new Promise((resolve) => setImmediate(resolve));

test("pruner settings saves changes and ignores display-only rows", async () => {
  const { current, saved, refreshed, list, row } = await openSettings();

  list.selectItem("showOccStatusLine");
  list.handleInput(" ");
  assert.equal(current.value.showOccStatusLine, !DEFAULT_CONFIG.showOccStatusLine);
  assert.equal(refreshed.length, 1);
  await flushSaves();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].showOccStatusLine, current.value.showOccStatusLine);

  list.selectItem("protectedTools");
  list.handleInput(" ");
  assert.equal(saved.length, 1);
  assert.equal(refreshed.length, 1);

  for (const id of ["enabled", "showOccStatusLine", "dedupByContentHash"]) {
    assert.deepEqual(row(id).values, ["true", "false"], `${id} cycles booleans`);
  }
});

test("pruner settings cycles enum and number rows, refreshes their text, and defaults an illegal number", async () => {
  const { current, list, row } = await openSettings();

  list.selectItem("batchingMode");
  list.handleInput(" ");
  assert.equal(current.value.batchingMode, "agent-message");

  list.selectItem("minBatchChars");
  const before = current.value.minBatchChars;
  list.handleInput(" ");
  const cycled = current.value.minBatchChars;
  assert.notEqual(cycled, before);
  assert.equal(row("minBatchChars").currentValue, String(cycled));
  assert.match(row("minBatchChars").description, new RegExp(`Currently ${cycled}\\b`));

  list.selectItem("compactionSummaryMaxTokens");
  list.handleInput(" ");
  assert.equal(current.value.compactionSummaryMaxTokens, 4096);
  assert.match(row("compactionSummaryMaxTokens").description, /Current limit: 4096/);

  // A value the row's cycle can still produce but the field rejects (hand-edited
  // settings.json can put one in the cycle) falls back to the configured default.
  row("minBatchChars").values = [String(cycled), "not-a-number"];
  row("minBatchChars").currentValue = String(cycled);
  list.selectItem("minBatchChars");
  list.handleInput(" ");
  assert.equal(current.value.minBatchChars, DEFAULT_CONFIG.minBatchChars);
  assert.match(row("minBatchChars").description, new RegExp(`Currently ${DEFAULT_CONFIG.minBatchChars}\\b`));

  const custom = await openSettings({ compactionSummaryMaxTokens: 12345 });
  assert.equal(custom.row("compactionSummaryMaxTokens").currentValue, "12345");
  custom.list.selectItem("compactionSummaryMaxTokens"); custom.list.handleInput(" ");
  assert.equal(custom.current.value.compactionSummaryMaxTokens, 0);
});

/** Captures the /pruner handler with no-op collaborators for untouched subcommands. */
function prunerCommand() {
  const current = { value: structuredClone(DEFAULT_CONFIG) };
  const saved = [];
  const notifications = [];
  let handler;
  const pi = {
    registerCommand: (_name, options) => { handler = options.handler; },
    registerMessageRenderer: () => {},
  };
  registerCommands(
    pi,
    current,
    async () => ({ ok: true, reason: "flushed", batchCount: 0, toolCallCount: 0, rawCharCount: 0, summaryCharCount: 0 }),
    () => [],
    () => ({ callCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, chainsCompressed: 0 }),
    () => undefined,
    new ToolCallIndexer(),
    async () => ({ compressedEntries: [], skipped: 0 }),
    undefined,
    undefined,
    undefined,
    async (value) => { saved.push(value); },
  );
  const ctx = {
    ui: {
      notify: (message, type) => { notifications.push({ message, type }); },
      select: async () => undefined,
      setStatus: () => {},
    },
  };
  return { current, saved, notifications, run: (args) => handler(args, ctx) };
}

test("pruner commands reject illegal simple-field values without saving", async () => {
  const { current, saved, notifications, run } = prunerCommand();

  await run("min-batch-chars -5");
  await run("thinking bogus");
  await run("batching bogus");
  await flushSaves();
  assert.deepEqual(notifications.map((entry) => entry.type), ["warning", "warning", "warning"]);
  assert.ok(notifications.slice(1).every(entry => entry.message.includes("bogus")));
  assert.equal(saved.length, 0);
  assert.equal(current.value.minBatchChars, DEFAULT_CONFIG.minBatchChars);
  assert.equal(current.value.summarizerThinking, DEFAULT_CONFIG.summarizerThinking);
  assert.equal(current.value.batchingMode, DEFAULT_CONFIG.batchingMode);

  await run("min-batch-chars 2000");
  await run("thinking low");
  await flushSaves();
  assert.deepEqual(saved.map((value) => [value.minBatchChars, value.summarizerThinking]), [[2000, "default"], [2000, "low"]]);
  // prune-on keeps its documented raw-string acceptance (no validation).
  await run("prune-on whatever");
  await flushSaves();
  assert.equal(current.value.pruneOn, "whatever");
});

test("native summary limit command accepts custom integers and reset, rejecting malformed values without saving", async () => {
  const { current, saved, notifications, run } = prunerCommand();
  for (const arg of ["-1", "1.5", "64junk", "NaN", "9007199254740992", "64 128"]) await run(`compaction-summary-limit ${arg}`);
  await flushSaves();
  assert.equal(saved.length, 0);
  assert.ok(notifications.every(entry => entry.type === "warning"));
  await run("compaction-summary-limit 12345");
  await run("compaction-summary-limit");
  assert.equal(current.value.compactionSummaryMaxTokens, 12345);
  await run("compaction-summary-limit 0");
  await flushSaves();
  assert.deepEqual(saved.map(value => value.compactionSummaryMaxTokens), [12345, 0]);
});
