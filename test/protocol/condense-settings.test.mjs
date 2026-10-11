import assert from "node:assert/strict";
import test from "node:test";
import { SettingsList } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { openPrunerSettings } from "../../src/condense/settings.ts";
import { registerCommands } from "../../src/condense/commands.ts";
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
    for (const [value, expected] of [
      [undefined, 0.7],
      [null, null],
      [0.5, 0.5],
      [2, 0.7],
      ["bad", 0.7],
    ]) {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { autoBudgetThreshold: value } }));
      assert.equal((await loadConfig()).autoBudgetThreshold, expected);
    }
    for (const value of [0, 8192, -1, 1.5, "8192", null, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(
        join(dir, "settings.json"),
        JSON.stringify({ contextPrune: { compactionSummaryMaxTokens: value } }),
      );
      assert.equal(
        (await loadConfig()).compactionSummaryMaxTokens,
        Number.isSafeInteger(value) && value >= 0 ? value : 0,
      );
    }
    const before = readFileSync(join(dir, "settings.json"), "utf8");
    const path = join(dir, "metis-pi.toml");
    writeFileSync(
      path,
      "[contextPrune]\nautoBudgetThreshold=false\nbudgetTurnDelta=false\n[contextPrune.sum" +
        "maryBudget]\nminGainTokens=512\nminGainFraction=0.1\nmaxProxyTokens=1000\nnativeTarg" +
        "etTokens=0\ngrowthHeadroomTokens=-1\n",
    );
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
function prunerCommand({ select = async () => undefined, save = async () => {} } = {}) {
  const current = { value: structuredClone(DEFAULT_CONFIG) };
  const saved = [];
  const notifications = [];
  const events = [];
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
    async () => ({ compressedEntries: [], skipped: 0 }),
    undefined,
    undefined,
    undefined,
    async (value) => { saved.push(value); events.push(["save", value]); await save(value); },
  );
  const ctx = {
    ui: {
      notify: (message, type) => { notifications.push({ message, type }); events.push(["notify", message, type]); },
      select: async (title, options) => { events.push(["select", title, options]); return select(title, options); },
      setStatus: (id, text) => { events.push(["status", id, text]); },
    },
  };
  return { current, saved, notifications, events, run: (args) => handler(args, ctx) };
}

test("pruner commands reject illegal simple-field values without saving", async () => {
  const { current, saved, notifications, run } = prunerCommand();

  const invalid = [
    ["min-batch-chars -5", 'Invalid minBatchChars: "-5". Expected a non-negative integer (0 disables).'],
    ["recovery-grace -5", 'Invalid recovery-grace: "-5". Expected a non-negative integer (0 disables).'],
    ["thinking bogus", "Invalid summarizer thinking level: bogus. Use one of: default, off, minimal, low, medium, high, xhigh."],
    ["thinking LOW", "Invalid summarizer thinking level: LOW. Use one of: default, off, minimal, low, medium, high, xhigh."],
    ["batching bogus", "Invalid batching mode: bogus. Use one of: turn, agent-message."],
    ["batching TURN", "Invalid batching mode: TURN. Use one of: turn, agent-message."],
  ];
  for (const [args] of invalid) await run(args);
  await flushSaves();
  assert.deepEqual(notifications, invalid.map(([, message]) => ({ message, type: "warning" })));
  assert.equal(saved.length, 0);
  assert.equal(current.value.minBatchChars, DEFAULT_CONFIG.minBatchChars);
  assert.equal(current.value.recoveryGraceTurns, DEFAULT_CONFIG.recoveryGraceTurns);
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

test("pruner scalar queries report current values without saving or refreshing status", async () => {
  const { current, saved, notifications, events, run } = prunerCommand();
  Object.assign(current.value, { summarizerThinking: "high", minBatchChars: 0, recoveryGraceTurns: 0, compactionSummaryMaxTokens: 12345 });
  const before = current.value;
  for (const args of ["thinking", "min-batch-chars", "recovery-grace", "compaction-summary-limit"]) await run(args);
  assert.deepEqual(notifications, [
    { message: "Current summarizer thinking: High (high)", type: undefined },
    { message: "Current minBatchChars: disabled.", type: undefined },
    { message: "Current recovery grace: disabled.", type: undefined },
    { message: "Native summary token limit: 12345.", type: undefined },
  ]);
  assert.equal(current.value, before);
  assert.equal(saved.length, 0);
  assert.ok(events.every(([kind]) => kind === "notify"));
});

test("pruner scalar selections cancel without effects and save before status or notification", async () => {
  let choice;
  const { current, saved, notifications, events, run } = prunerCommand({ select: async () => choice });
  const before = current.value;
  await run("prune-on");
  await run("batching");
  assert.deepEqual(events, [
    ["select", "pruner — choose when to trigger summarization", ["agent-message — On agent message", "on-demand — On demand"]],
    ["select", "pruner — choose batching granularity", ["turn — Per turn", "agent-message — Per agent message"]],
  ]);
  assert.equal(current.value, before);
  assert.equal(saved.length, 0);
  assert.equal(notifications.length, 0);

  events.length = 0;
  choice = "on-demand — On demand";
  await run("prune-on");
  assert.equal(current.value.pruneOn, "on-demand");
  assert.deepEqual(events.map(([kind]) => kind), ["select", "save", "status"]);
  assert.deepEqual(events[2], ["status", "context-prune", "│ prune: OFF · usage: 0 tokens"]);
  assert.equal(saved[0], current.value);

  events.length = 0;
  choice = "agent-message — Per agent message";
  await run("batching");
  assert.equal(current.value.batchingMode, "agent-message");
  assert.deepEqual(events.map(([kind]) => kind), ["select", "save", "notify"]);
  assert.deepEqual(notifications, [{ message: "Batching mode set to: Per agent message", type: undefined }]);
  assert.equal(saved[1], current.value);
});

test("pruner integer commands preserve prefix parsing, extra arguments and zero disabling", async () => {
  for (const [verb, key, zeroMessage] of [
    ["min-batch-chars", "minBatchChars", "minBatchChars set to 0 — pre-flush trivial-batch skipping disabled."],
    ["recovery-grace", "recoveryGraceTurns", "recovery-grace set to 0 - context_tree_query output stubs immediately."],
  ]) {
    const { current, saved, notifications, events, run } = prunerCommand();
    await run(`${verb} 17chars ignored`);
    assert.equal(current.value[key], 17);
    await run(`${verb} 0`);
    assert.deepEqual(saved.map(value => value[key]), [17, 0]);
    assert.equal(current.value[key], 0);
    assert.deepEqual(notifications.at(-1), { message: zeroMessage, type: undefined });
    assert.deepEqual(events.map(([kind]) => kind), ["save", "notify", "save", "notify"]);
  }
});

test("pruner dedup preserves case-insensitive aliases and read-only status", async () => {
  const { current, saved, notifications, events, run } = prunerCommand();
  for (const arg of ["OFF", "TrUe", "ON", "FALSE"]) await run(`dedup ${arg}`);
  assert.deepEqual(saved.map(value => value.dedupByContentHash), [false, true, true, false]);
  assert.equal(current.value.dedupByContentHash, false);
  assert.deepEqual(notifications.map(({ message }) => message), [
    "Content-hash dedup turned OFF.", "Content-hash dedup turned ON.",
    "Content-hash dedup turned ON.", "Content-hash dedup turned OFF.",
  ]);
  const before = current.value;
  await run("dedup");
  await run("dedup STATUS");
  assert.match(notifications.at(-1).message, /^Content-hash dedup is OFF\./);
  assert.deepEqual(notifications.at(-1), notifications.at(-2));
  await run("dedup enabled");
  assert.deepEqual(notifications.at(-1), { message: 'Invalid dedup value: "enabled". Expected on, off, status, true, or false.', type: "warning" });
  assert.equal(current.value, before);
  assert.equal(saved.length, 4);
  assert.ok(events.every(([kind]) => kind !== "status"));
});

test("pruner enum arguments keep extra-word tolerance and loose trigger strings", async () => {
  const { current, saved, notifications, events, run } = prunerCommand();
  await run("thinking low ignored");
  await run("batching agent-message ignored");
  await run("prune-on arbitrary ignored");
  assert.equal(current.value.summarizerThinking, "low");
  assert.equal(current.value.batchingMode, "agent-message");
  assert.equal(current.value.pruneOn, "arbitrary");
  assert.deepEqual(saved.map(value => [value.summarizerThinking, value.batchingMode, value.pruneOn]), [
    ["low", "turn", "agent-message"], ["low", "agent-message", "agent-message"], ["low", "agent-message", "arbitrary"],
  ]);
  assert.deepEqual(notifications, [
    { message: "Summarizer thinking set to: low", type: undefined },
    { message: "Batching mode set to: Per agent message", type: undefined },
  ]);
  assert.deepEqual(events.map(([kind]) => kind), ["save", "notify", "save", "notify", "save", "status"]);
});

test("pruner on/off preserves save-notify-status order and untouched nested settings", async () => {
  const { current, saved, events, run } = prunerCommand();
  const { chainCompression, purgeErrors } = current.value;
  for (const [verb, enabled, message, status] of [
    ["on", true, "Context pruning enabled.", "│ prune: ON · usage: 0 tokens"],
    ["off", false, "Context pruning disabled.", "│ prune: OFF · usage: 0 tokens"],
  ]) {
    const before = current.value;
    events.length = 0;
    await run(`${verb} ignored`);
    assert.equal(current.value.enabled, enabled);
    assert.notEqual(current.value, before);
    assert.equal(before.enabled, !enabled, "the previous config snapshot is not mutated");
    assert.equal(current.value.chainCompression, chainCompression);
    assert.equal(current.value.purgeErrors, purgeErrors);
    assert.equal(saved.at(-1), current.value);
    assert.deepEqual(events, [
      ["save", current.value], ["notify", message, undefined], ["status", "context-prune", status],
    ]);
  }
  assert.deepEqual(saved.map(value => value.enabled), [true, false]);
});

test("pruner scalar save stays non-blocking and a failure leaves the session change applied", async () => {
  let rejectSave;
  const pendingSave = new Promise((_, reject) => { rejectSave = reject; });
  const { current, notifications, events, run } = prunerCommand({ save: () => pendingSave });
  let returned = false;
  const running = run("thinking low").then(() => { returned = true; });
  try {
    await flushSaves();
    assert.equal(returned, true, "the command must not await persistence");
    assert.equal(current.value.summarizerThinking, "low");
    assert.deepEqual(events.map(([kind]) => kind), ["save", "notify"]);
    assert.deepEqual(notifications, [{ message: "Summarizer thinking set to: low", type: undefined }]);
  } finally {
    rejectSave(new Error("disk full"));
    await running;
    await flushSaves();
  }
  assert.equal(current.value.summarizerThinking, "low");
  assert.equal(notifications.at(-1).type, "error");
  assert.match(notifications.at(-1).message, /Could not save settings to .*disk full.*Change applies to this session only\./);
});
