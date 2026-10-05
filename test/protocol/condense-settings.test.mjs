import assert from "node:assert/strict";
import test from "node:test";
import { SettingsList } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { openPrunerSettings } from "../../src/condense/settings.ts";
import { registerCommands } from "../../src/condense/commands.ts";
import { ToolCallIndexer } from "../../src/condense/indexer.ts";
import { DEFAULT_CONFIG } from "../../src/condense/types.ts";
import { loadConfig } from "../../src/condense/config.ts";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Opens the real overlay and hands back its row list plus the save/refresh recorders. */
async function openSettings() {
  initTheme("dark", false);
  const current = { value: structuredClone(DEFAULT_CONFIG) };
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

  // A value the row's cycle can still produce but the field rejects (hand-edited
  // settings.json can put one in the cycle) falls back to the configured default.
  row("minBatchChars").values = [String(cycled), "not-a-number"];
  row("minBatchChars").currentValue = String(cycled);
  list.handleInput(" ");
  assert.equal(current.value.minBatchChars, DEFAULT_CONFIG.minBatchChars);
  assert.match(row("minBatchChars").description, new RegExp(`Currently ${DEFAULT_CONFIG.minBatchChars}\\b`));
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
