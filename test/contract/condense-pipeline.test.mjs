import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, convertToLlm, createEventBus, estimateTokens, initTheme } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { SettingsList } from "@earendil-works/pi-tui";
import { fixture, usage } from "../helpers/condense-pipeline.mjs";
import { TokenEstimator } from "../../src/condense/token-estimator.ts";
import { summaryBudget, shouldBudgetFlush } from "../../src/condense/budget.ts";
import { toolResultStub } from "../../src/condense/pruner.ts";
import { projectBranchMessages, serializeBatchForSummarizer } from "../../src/condense/batch-capture.ts";
import goalExtension from "../../extensions/goal.ts";
import { loadConfig, DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { parseMetisConfig } from "../../src/configuration/store.ts";
import { stringify } from "smol-toml";
import { disableNetwork } from "../helpers/native-provider.mjs";
import { METIS_EVENTS } from "../../src/collaboration.ts";

test.beforeEach(disableNetwork);

const buildLog =
  Array.from({ length: 300 }, (_, i) => `building artifact ${i}: ` + "x".repeat(70)).join("\n") + "\nBUILD COMPLETE";

async function waitForSummarizer(f, count = 1) {
  // Wait for provider starts, not a machine-speed assumption about preflight tokenization.
  const signal = AbortSignal.timeout(15000);
  while (f.calls.length < count) await once(f.summaryStarted, "request", { signal });
}

async function changeSetting(f, id, selectedValue) {
  initTheme("dark", false);
  f.ctx.ui.custom = async (factory) => {
    const overlay = factory(null, null, null, () => {});
    const list = overlay.children.find(child => child instanceof SettingsList);
    assert.ok(list, "the settings command must open the actual SettingsList");
    list.selectItem(id);
    if (selectedValue === undefined) list.handleInput(" ");
    else {
      const row = list.items.find(item => item.id === id);
      for (let i = 0; row.currentValue !== selectedValue && i < row.values.length; i++) list.handleInput(" ");
      assert.equal(row.currentValue, selectedValue, "the settings list reaches the requested preset");
    }
  };
  await f.commands.get("pruner").handler("settings", f.ctx);
}

test("a busy TUI tool loop leaves automatic paid summaries for the idle session", { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", defer: true });
  let idle = false;
  f.ctx.isIdle = () => idle;
  const { id } = f.add(buildLog, "produce-output");
  await f.finish(false, usage); // A successful request must consume the result before pruning it.
  const { assistant, result } = f.add("The next result", "produce-output");
  await f.emit("turn_end", { message: assistant, toolResults: [result], turnIndex: 0 });
  assert.equal(f.calls.length, 0);
  const flush = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics");
  assert.deepEqual(flush.data.deferredReasons, { idle: 1 });
  assert.equal(flush.data.metrics, undefined, "budget-triggered foreground work does not need full history metrics");

  idle = true;
  f.ctx.hasPendingMessages = () => true;
  await f.emit("agent_settled", { aborted: false });
  await f.waitMaintenance();
  assert.equal(f.calls.length, 0, "queued input wins over a paid summary");
  f.ctx.hasPendingMessages = () => false;
  await f.emit("agent_settled", { aborted: false });
  await waitForSummarizer(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sm.getBranch().some(entry => entry.customType === "context-prune-summary"), false);
  f.release();
  await f.waitMaintenance();
  assert.ok(f.sm.getBranch().some(entry => entry.customType === "context-prune-summary"
    && entry.details.toolCallRefs.some(ref => ref.toolCallId === id)));
});

test("fresh input does not wait for an idle summary and late output cannot replace its evidence", { timeout: 20000 }, async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", defer: true, ignoreAbort: true });
  let idle = false;
  f.ctx.isIdle = () => idle;
  const { id, result: original } = f.add(buildLog, "produce-output");
  await f.finish(false, usage);
  const { assistant, result } = f.add("The next result", "produce-output");
  await f.emit("turn_end", { message: assistant, toolResults: [result], turnIndex: 0 });
  idle = true;
  await f.emit("agent_settled", { aborted: false });
  await waitForSummarizer(f);

  const abort = AbortSignal.timeout(5000);
  // Release even if the implementation incorrectly waits for the provider.
  const release = () => f.release();
  abort.addEventListener("abort", release, { once: true });
  try {
    await f.emit("before_agent_start");
    idle = false;
    f.sm.appendMessage({ role: "user", content: "Next request", timestamp: f.nextTimestamp() });
    const messages = f.sm.buildSessionProjection().messages;
    const next = await f.emit("context", { messages });
    assert.equal(abort.aborted, false, "the next request was prepared while the provider was still holding the summary");
    assert.ok(f.requests[0].signal.aborted);
    assert.deepEqual((next?.messages ?? messages).find(message => message.toolCallId === id)?.content, original.content);
  } finally {
    abort.removeEventListener("abort", release);
    release();
  }
  await f.waitMaintenance();
  assert.equal(f.sm.getBranch().some(entry => entry.customType === "context-prune-summary"), false);
});

test("Native usage reads coalesce within a source slice and refresh after an await", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", capacity: true });
  let epoch = 0, tokens = 75000;
  const reads = [], duplicates = [], seen = new Set();
  f.ctx.getContextUsage = () => {
    const key = `${epoch}:${f.sm.getLeafId()}`;
    if (seen.has(key)) duplicates.push(key);
    seen.add(key); reads.push(tokens);
    queueMicrotask(() => { epoch++; });
    return { tokens, contextWindow: 100000 };
  };
  const batch = f.add(buildLog);
  await f.emit("turn_end", { message: batch.assistant, toolResults: [batch.result], turnIndex: 0 });
  assert.ok(reads.length > 0);
  const message = { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
    content: [{ type: "toolCall", id: "later", name: "bash", arguments: {} }], timestamp: f.nextTimestamp() };
  const leaf = f.sm.getLeafId();
  tokens = 20000; await f.emit("message_end", { message });
  assert.equal(reads.at(-1), 20000);
  tokens = 30000; await f.emit("message_end", { message: { ...message, timestamp: f.nextTimestamp() } });
  assert.equal(f.sm.getLeafId(), leaf);
  assert.equal(reads.at(-1), 30000, "fresh usage is required even when an await did not append a source");
  assert.deepEqual(duplicates, [], "an unchanged synchronous source must not rebuild Native usage twice");
});

test("settings Off suppresses automatic paid summaries while explicit manual summaries remain available", async t => {
  const f = await fixture(t);
  await changeSetting(f, "autoBudgetThreshold", "0");
  f.add("semantic source ".repeat(2000), "unknown-command", "auto-budget-off");
  await f.finish();
  assert.equal(f.calls.length, 0, "Off blocks automatic model work even at high pressure");
  assert.equal((await loadConfig()).autoBudgetThreshold, null, "the disabled threshold survives the settings save");
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.equal(f.calls.length, 1, "explicit manual summaries retain their model admission");
});

function addClosedChains(f, thinking = "Independent intermediate reasoning. ".repeat(100)) {
  for (let i = 0; i < 2; i++) {
    f.sm.appendMessage({ role: "user", content: `request-${i}`, timestamp: f.nextTimestamp() });
    f.add(`raw-${i}`, `echo member-${i}`, `member-${i}`, thinking);
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `final-${i}` }],
      stopReason: "stop", timestamp: f.nextTimestamp() });
  }
}

async function independentTasks(t, {
  total, sizes, price, rates, perTurn = 18000, gaps = [], minRecentTokens = DEFAULT_CONFIG.chainCompression.minRecentTokens,
}) {
  const f = await fixture(t, { pruneOn: "on-demand", autoBudgetThreshold: null,
    chainCompression: { ...DEFAULT_CONFIG.chainCompression, rollingWindow: 1, minRecentTokens, fuseRangeSummary: false } });
  Object.assign(f.ctx.model, { contextWindow: 2000000, cost: rates ?? { input: price, output: 0, cacheRead: 1, cacheWrite: price } });
  const line = "value_0123456789 = 0xabcdef123456;\n";
  const text = tokens => line.repeat(Math.ceil(tokens * 4 / line.length)).slice(0, tokens * 4);
  const header = total - sizes.reduce((a, b) => a + b, 0) - gaps.reduce((a, b) => a + b, 0) - 4 * perTurn;
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: text(header) }],
    stopReason: "stop", timestamp: f.nextTimestamp() });
  for (let i = 0; i < 3; i++) {
    const message = { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
      content: [{ type: "text", text: "Earlier main request" }], stopReason: "stop", timestamp: f.nextTimestamp(),
      usage: { ...usage, input: total * 0.02, cacheRead: total * 0.98 } };
    await f.emit("message_end", { message }); f.sm.appendMessage(message);
  }
  const tasks = sizes.map((size, i) => {
    if (gaps[i]) f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: text(gaps[i]) }],
      stopReason: "stop", timestamp: f.nextTimestamp() });
    const user = `independent request ${i}`, final = `independent result ${i}`;
    f.sm.appendMessage({ role: "user", content: user, timestamp: f.nextTimestamp() });
    const call = f.add(text(size), "inspect-source", `independent-${i}`);
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: final }],
      stopReason: "stop", timestamp: f.nextTimestamp() });
    return { ...call, user, final };
  });
  f.sm.appendMessage({ role: "user", content: "Continue the active investigation", timestamp: f.nextTimestamp() });
  const active = Array.from({ length: 4 }, (_, i) => f.add(text(perTurn), "inspect-source", `active-${i}`));
  return { ...f, tasks, active };
}


test("no-op completions skip history while real spills retain capacity accounting with OCC off", async t => {
  const f = await fixture(t, { spillThreshold: 1000, spillPreviewBytes: 64, recoveryGraceTurns: 0, occ: false, capacity: true });
  let tokens = 80000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: 100000 });
  const sizes = [];
  f.events.on(METIS_EVENTS.condenseProject, request => { sizes.push(JSON.stringify(request.messages).length); });
  const small = f.add("small retained result", "unrecognized-command", "no-spill");
  await f.emit("turn_end", { message: small.assistant, toolResults: [small.result], turnIndex: 0 });
  assert.equal(sizes.length, 0, "no rewrite means no before/after capacity projection");
  const large = f.add("ORIGINAL_" + "x".repeat(2000), "unrecognized-command", "real-spill");
  await f.emit("turn_end", { message: large.assistant, toolResults: [large.result], turnIndex: 1 });
  assert.ok(sizes.length >= 2, "native stale-capacity accounting still measures both sides of a rewrite");
  assert.ok(sizes[0] > sizes.at(-1), "measurement observes the original result before its indexed stub");
  tokens = 89550; // 90% of Pi's 100000 - 500 effective threshold, even with OCC disabled.
  const retained = f.add("NATIVE_PENDING_" + "y".repeat(2000), "unrecognized-command", "native-spill");
  const expected = structuredClone(retained.result);
  await f.emit("turn_end", { message: retained.assistant, toolResults: [retained.result], turnIndex: 2 });
  const projected = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
  assert.deepEqual(projected.find(m => m.toolCallId === retained.id), expected);
  assert.equal(f.calls.length, 0);
});

function observeProjectionReads(t, manager, onRead) {
  for (const name of ["buildSessionProjection", "buildSessionProjectionAsync"]) {
    if (typeof manager[name] !== "function") continue;
    const project = manager[name].bind(manager);
    t.mock.method(manager, name, (...args) => { onRead(); return project(...args); });
  }
}

test("TUI context gives pending UI work a turn before reading its projection", async t => {
  const f = await fixture(t, { mode: "tui" });
  const steps = [];
  observeProjectionReads(t, f.sm, () => steps.push("projected"));
  const pending = f.emit("context", { messages: [{ role: "user", content: "Next", timestamp: 2 }] });
  queueMicrotask(() => steps.push("ui checkpoint"));
  await pending;
  assert.equal(steps[0], "ui checkpoint");
  assert.ok(steps.includes("projected"), "the projection still completes");
});

test("TUI boundary maintenance is deferred, coalesced and remains awaitable", async t => {
  const f = await fixture(t, { mode: "tui" });
  let reads = 0;
  observeProjectionReads(t, f.sm, () => reads++);
  await f.emit("turn_end", { toolResults: [] });
  await f.emit("agent_settled", { aborted: false });
  assert.equal(reads, 0, "boundary callbacks must not run heavy maintenance inline");
  const status = {};
  f.events.emit("metis:condense-maintenance", status);
  assert.ok(status.pending instanceof Promise, "OCC/shutdown must see scheduled work too");
  await f.waitMaintenance();
  assert.ok(reads > 0, "work is drained, not silently discarded");
});

test("foreground TUI projection preempts older queued maintenance", async t => {
  const f = await fixture(t, { mode: "tui" });
  await f.emit("agent_settled", { aborted: false });
  const queued = {};
  f.events.emit("metis:condense-maintenance", queued);
  assert.ok(queued.pending instanceof Promise);
  let readWhileMaintenancePending = false, reads = 0;
  observeProjectionReads(t, f.sm, () => {
    reads++;
    const status = {};
    f.events.emit("metis:condense-maintenance", status);
    readWhileMaintenancePending ||= Boolean(status.pending);
  });
  const messages = [{ role: "user", content: "Next", timestamp: 2 }];
  const result = await f.emit("context", { messages });
  assert.deepEqual(result?.messages ?? messages, messages);
  assert.ok(reads > 0, "foreground projection still runs after cancelling queued work");
  assert.equal(readWhileMaintenancePending, false, "old background work must not steal the foreground frame");
  await queued.pending;
  await f.waitMaintenance();
});

for (const boundary of ["session_tree", "session_start"])
  test(`TUI ${boundary} waits for handed-off shared-chain validation`, async t => {
    const f = await fixture(t, { mode: "tui", pruneOn: "on-demand",
      chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
    addClosedChains(f);
    await f.emit("agent_settled");
    await f.waitMaintenance();
    const raw = () => f.sm.buildSessionProjection().messages;
    const initial = (await f.emit("context", { messages: raw() }))?.messages ?? raw();
    assert.ok(initial.some(message => message.metisDerived?.kind === "condense-chain"));
    const restoreLeaf = f.sm.getLeafId();
    if (boundary === "session_tree") f.sm.appendCustomEntry("test-navigation", {});
    await f.emit("agent_settled");
    const queued = {};
    f.events.emit("metis:condense-maintenance", queued);
    assert.ok(queued.pending instanceof Promise, "the previous boundary must still own a queued pass");
    // A real leaf transition retains the published chain but drops only
    // display-neutral metadata, so the expected source projection is unchanged.
    if (boundary === "session_tree") f.sm.branch(restoreLeaf);
    await f.emit(boundary);
    const restored = (await f.emit("context", { messages: raw() }))?.messages ?? raw();
    assert.ok(restored.some(message => message.metisDerived?.kind === "condense-chain"),
      "completed restoration must retain its published shared projection, not cancel its still-pending handoff");
    assert.deepEqual(restored, initial);
  });

test("shutdown cancels TUI maintenance before its deferred source read", async t => {
  const f = await fixture(t, { mode: "tui" });
  let reads = 0;
  observeProjectionReads(t, f.sm, () => reads++);
  await f.emit("agent_settled", { aborted: false });
  const status = {};
  f.events.emit("metis:condense-maintenance", status);
  assert.ok(status.pending instanceof Promise);
  await f.emit("session_shutdown");
  await status.pending;
  assert.equal(reads, 0, "cancelled background work must not touch the old session");
});

test("queued TUI details retain reclaim metrics without notices; RPC keeps notifications", async t => {
  for (const mode of ["tui", "rpc"]) await t.test(mode, async t => {
    const f = await fixture(t, { mode, showPruneStatusLine: true });
    assert.match(f.statuses.get("context-prune"), /\nNo pending turns$/);
    f.add("semantic source ".repeat(2000), "unknown-command", "already-pruned");
    await f.finish();
    assert.equal(f.notices.length, mode === "tui" ? 1 : 0, "only TUI gains a confirmed automatic action notice");
    if (mode === "tui") assert.match(f.notices[0][0], /pruner: pruned 1 tool batch/);
    const messages = f.sm.buildSessionProjection().messages;
    await f.emit("context", { messages });
    const summary = f.statuses.get("context-prune").split("\n")[0];
    assert.match(summary, /^│ prune: ON · [\d.kM]+->[\d.kM]+ \(-\d+%\) · usage: 20 tokens$/);
    f.notices.length = 0;
    for (let i = 0; i < 7; i++) {
      const call = f.add(`pending evidence ${i}`, "unknown-command", `pending-${i}`);
      await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: i });
    }
    const status = f.statuses.get("context-prune");
    assert.equal(status.split("\n")[0], summary, "queue updates must not replace reclaim or usage");
    assert.match(status, /\n7 turns queued — will evaluate packing and summary budget on agent's next text checkpoint$/);
    assert.equal(f.notices.some(([message]) => /turns? queued/.test(message)), mode !== "tui");
    await f.emit("agent_end");
    assert.equal(f.statuses.get("context-prune"), status, "agent_end must not discard the latest detail");
    for (const trigger of ["on-demand", "agent-message"]) {
      await f.commands.get("pruner").handler(`prune-on ${trigger}`, f.ctx);
      const refreshed = f.statuses.get("context-prune");
      assert.equal(refreshed.split("\n")[0], summary, "changing the trigger preserves reclaim and usage");
      assert.ok(refreshed.endsWith(trigger === "on-demand" ? "/pruner now" : "agent's next text checkpoint"),
        "queued instructions follow the current trigger, not the mode at capture time");
      await f.emit("agent_end");
      assert.equal(f.statuses.get("context-prune"), refreshed);
    }
    await f.commands.get("pruner").handler("status", f.ctx);
    await f.commands.get("pruner").handler("thinking invalid", f.ctx);
    assert.ok(f.notices.some(([message]) => /^pruner status:/.test(message)), "explicit command replies remain visible");
    assert.ok(f.notices.some(([message, type]) => /Invalid summarizer thinking/.test(message) && type === "warning"));
    assert.equal(f.calls.length, 1, "disclosure never initiates model work");
  });
});

test("recovered queue instructions follow the current prune trigger", async t => {
  const f = await fixture(t, { mode: "tui", showPruneStatusLine: true, pruneOn: "on-demand" });
  f.add("semantic source ".repeat(2000), "unknown-command", "reload-pending");
  await f.emit("session_tree");
  assert.match(f.statuses.get("context-prune"), /pending batch\(es\) recovered.*\/pruner now$/);
  await f.commands.get("pruner").handler("prune-on agent-message", f.ctx);
  assert.match(f.statuses.get("context-prune"), /pending batch\(es\) recovered.*agent's next text checkpoint$/);
  assert.equal(f.calls.length, 0, "changing trigger instructions does not initiate model work");
});

test("persistence failures with embedded stale wording stay write failures and can retry", async t => {
  const f = await fixture(t, { pruneOn: "on-demand" });
  const source = f.add("semantic evidence ".repeat(2000), "unknown-command", "write-failure");
  const mock = t.mock.method(f.pi, "sendMessage", () => {
    throw new Error('Storage write failed while logging "This extension ctx is stale"');
  });
  await f.commands.get("pruner").handler("now", f.ctx);
  const failed = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data;
  assert.equal(failed.reason, "failed", "quoted error text does not prove a stale host context");
  assert.equal(failed.outcome, "error");
  assert.equal(f.sm.buildSessionProjection().messages.find(message => message.toolCallId === source.id).content[0].text,
    source.result.content[0].text);
  assert.ok(!f.sm.getBranch().some(entry => entry.customType === "context-prune-summary"));
  mock.mock.restore();
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.equal(f.calls.length, 2);
  assert.ok(f.sm.getBranch().some(entry => entry.customType === "context-prune-summary"));
});

test("published character savings match the actual context projection across multiple summaries", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", batchingMode: "turn" });
  f.sm.appendMessage({ role: "user", content: "unrelated history ".repeat(10000), timestamp: f.nextTimestamp() });
  f.add("first semantic evidence ".repeat(2000), "unknown-first", "first-summary");
  f.add("second semantic evidence ".repeat(2000), "unknown-second", "second-summary");
  await f.finish();
  const projection = async () => {
    const messages = f.sm.buildSessionProjection().messages;
    return (await f.emit("context", { messages }))?.messages ?? messages;
  };
  const before = await projection();
  await f.commands.get("pruner").handler("now", f.ctx);
  const after = await projection();
  const metrics = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data;
  assert.equal(f.calls.length, 2, "separate turns publish two ordered summaries");
  assert.equal(metrics.publishedCharsSaved, JSON.stringify(before).length - JSON.stringify(after).length);
  assert.equal(metrics.firstChangedMessage, before.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(after[index])));
});

test("packing precedes the 5000-char gate and keeps settled history stable with chain compression disabled", async (t) => {
  const f = await fixture(t);
  const call = f.add(buildLog);
  await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  assert.equal(f.calls.length, 0, "pressure hints cannot trigger a mid-task model call in final-reply mode");
  await f.finish();
  assert.equal(f.calls.length, 0, "a large raw batch whose packed body is below 5000 needs no model");
  // Inspect semantic persistence, not a guessed custom type spelling.
  const summary = f.sm.getBranch().find(e => e.type === "custom_message" && e.details?.representation === "packed");
  assert.ok(summary);
  assert.match(summary.content, /BUILD COMPLETE/);
  const recovered = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id] }, undefined, undefined, f.ctx);
  assert.equal(recovered.details.results[0].text, buildLog);
  const before = (await f.emit("context", { messages: projectBranchMessages(f.sm.getBranch()) })).messages;
  f.sm.appendMessage({ role: "user", content: "next", timestamp: 50 });
  f.add("small response", "echo small"); await f.finish();
  const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()), api: f.ctx.model.api };
  f.events.emit("metis:condense-project", request);
  const live = (await f.emit("context", { messages: projectBranchMessages(f.sm.getBranch()) })).messages;
  assert.deepEqual(request.messages, live, "projection bus and live use the same projection");
  assert.deepEqual(live.slice(0, before.length), before, "later final replies do not rewrite old settled blocks");
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.sm.getBranch().filter((e) => e.type === "custom_message" && e.details?.representation === "packed").length,
    1,
  );
  assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-chain").length, 0);
});

test("default chain policy releases old evidence but retains a long active multi-read task", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", chainCompression: DEFAULT_CONFIG.chainCompression });
  f.ctx.model.contextWindow = 1000000;
  const evidence = Array.from({ length: 6000 }, (_, i) => `evidence-${i}: inspected source and established fact ${i * 17}`).join("\n");
  const old = f.add(evidence, "inspect-old", "old-default");
  await f.finish();
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 0,
    "finishing one task does not immediately age its fresh evidence out of the default working set");
  f.sm.appendMessage({ role: "user", content: "Investigate before making the next decision", timestamp: f.nextTimestamp() });
  const active = [];
  for (let i = 0; i < 4; i++) active.push(f.add(evidence.slice(0, 75000), "inspect-current", `active-${i}`));
  await f.emit("agent_settled"); await f.waitMaintenance();
  const blocks = f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
  assert.equal(blocks.length, 1, "a large old block outside the reference budget can publish even with rollingWindow=3");
  const original = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: original }))?.messages ?? original;
  assert.equal(projected.some(m => m.toolCallId === old.id), false);
  for (const call of active) assert.deepEqual(projected.find(m => m.toolCallId === call.id), call.result,
    "active investigation results remain intact, not just their references");
  assert.equal(f.calls.length, 0, "mechanical maintenance does not add summary calls");
  const notices = f.notices.length;
  await f.emit("agent_settled"); await f.waitMaintenance();
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 1);
  assert.equal(f.notices.length, notices, "unchanged boundaries cannot trigger a second rewrite");
});

test("independent small chains publish without paid summaries while preserving the active tail and exact recovery", async t => {
  for (const scenario of [
    { total: 128000, sizes: [32000], price: 10, publish: true },
    { total: 128000, sizes: [32000], price: 10, providerTokens: 1000000, publish: false },
    { total: 1000000, sizes: [32000], price: 10, publish: true },
    { total: 1000000, sizes: [6000], price: 2, publish: true },
    { total: 1000000, sizes: [32000], price: 2, perTurn: 240000, publish: false },
    { total: 128000, sizes: [32000], price: 10, perTurn: 14000, publish: true },
    { total: 128000, sizes: [32000], price: 10, perTurn: 14000, minRecentTokens: 65536, publish: false },
    { total: 190000, sizes: [1000, 32000, 5000, 5000, 5000, 5000], gaps: [0, 60000],
      price: 20, perTurn: 12000, publish: true, selected: 1 },
    // The largest older body cannot repay its cold suffix; the later, smaller body can.
    { total: 200000, sizes: [26000, 24000, 2500, 2500, 2500, 2500], gaps: [0, 80000],
      perTurn: 8500, publish: true, selected: 1,
      rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] } },
  ]) await t.test(JSON.stringify(scenario), async t => {
    const f = await independentTasks(t, scenario);
    if (scenario.providerTokens) f.ctx.getContextUsage = () => ({ tokens: scenario.providerTokens, contextWindow: 2000000 });
    await f.emit("agent_settled"); await f.waitMaintenance();
    const entries = f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
    assert.equal(entries.length, Number(scenario.publish));
    const raw = f.sm.buildSessionProjection().messages;
    const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
    for (const call of f.active) assert.deepEqual(projected.find(m => m.toolCallId === call.id), call.result);
    for (const task of f.tasks) {
      assert.ok(projected.some(m => m.role === "user" && m.content === task.user));
      assert.ok(projected.some(m => m.role === "assistant" && m.content?.some(b => b.text === task.final)));
    }
    assert.equal(f.calls.length, 0);
    if (!scenario.publish) {
      assert.deepEqual(projected.find(m => m.toolCallId === f.tasks[0].id), f.tasks[0].result);
      return;
    }
    const selectedIndex = scenario.selected ?? 0;
    const selected = f.tasks[selectedIndex];
    assert.ok(!projected.some(message => message.toolCallId === selected.id));
    for (const task of f.tasks.slice(0, selectedIndex))
      assert.deepEqual(projected.find(message => message.toolCallId === task.id), task.result, "earlier rejected work keeps its prefix");
    let cursor, recovered = "", pages = 0, eof = false;
    do {
      const page = await f.tools.get("context_tree_query").execute("recall",
        { toolCallIds: [selected.id], cursor }, undefined, undefined, f.ctx);
      assert.equal(page.isError, false);
      for (const result of page.details.results) {
        assert.equal(result.offsetBytes, Buffer.byteLength(recovered));
        recovered += result.text;
      }
      cursor = page.details.nextCursor; eof = page.details.eof;
      assert.ok(++pages <= 16);
    } while (cursor);
    assert.equal(eof, true);
    assert.ok(recovered === selected.result.content[0].text, "all recall pages reconstruct the exact original result");
    await f.emit("agent_settled"); await f.waitMaintenance();
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 1);
  });
});

test("an earlier rewrite includes eligible later chains in the first request without extra summaries", async t => {
  const f = await independentTasks(t, { total: 240000, sizes: [49000, 31000, 2500, 2500, 2500, 2500],
    perTurn: 8500, price: 20 });
  await f.emit("agent_settled"); await f.waitMaintenance();
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  const cut = raw.findIndex(message => message.role === "user" && message.content === f.tasks[0].user) + 1;
  assert.ok(cut > 0);
  assert.deepEqual(projected.slice(0, cut), raw.slice(0, cut), "joining the suffix does not change the reusable prefix");
  const tokens = messages => messages.reduce((total, message) => total + estimateTokens(message), 0);
  assert.ok(tokens(raw) - tokens(projected) > estimateTokens(f.tasks[0].result), "the first input saves more than the first result");
  await f.emit("session_start"); await f.waitMaintenance();
  assert.deepEqual((await f.emit("context", { messages: raw }))?.messages, projected, "resume retains the same combined replacement");
  for (const task of f.tasks.slice(0, 2)) {
    assert.ok(!projected.some(message => message.toolCallId === task.id), `first request retains raw ${task.id}`);
    assert.ok(projected.some(message => message.role === "user" && message.content === task.user));
    assert.ok(projected.some(message => message.role === "assistant" && message.content?.some(block => block.text === task.final)));
    const page = await f.tools.get("context_tree_query").execute("recall", { toolCallIds: [task.id], maxBytes: 2048 },
      undefined, undefined, f.ctx);
    assert.equal(page.isError, false);
    assert.equal(page.details.results[0].text.slice(0, 1024), task.result.content[0].text.slice(0, 1024));
  }
  for (const call of f.active) assert.deepEqual(projected.find(message => message.toolCallId === call.id), call.result);
  assert.equal(projected.filter(message => message.metisDerived?.kind === "condense-chain").length, 1);
  assert.equal(f.calls.length, 0);
});

test("bounded Responses lookup counts the rendered shared summary and not each replaced chain", async t => {
  const f = await independentTasks(t, { total: 240000, sizes: [49000, ...Array(6).fill(2500)], perTurn: 8500, price: 10 });
  const model = Object.assign(f.ctx.model, { api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true } });
  const raw = f.sm.buildSessionProjection().messages;
  const toInput = messages => convertResponsesMessages(model, { messages: convertToLlm(messages) }, new Set([model.provider]));
  const input = toInput(raw);
  for (let i = 0; i < 3; i++) {
    await f.emit("context", { messages: raw });
    await f.emit("before_provider_request", { payload: { model: model.id, input } });
    await f.emit("message_end", { message: { role: "assistant", api: model.api, provider: model.provider,
      model: model.id, content: [{ type: "text", text: "Already consumed" }], stopReason: "stop",
      timestamp: f.nextTimestamp(), usage: { ...usage, input: 4800, cacheRead: 235200 } } });
  }
  await f.emit("agent_settled"); await f.waitMaintenance();
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  const after = toInput(projected);
  const cut = input.findIndex(item => item.role === "user" && item.content.some(block => block.text === f.tasks[0].user)) + 1;
  assert.ok(cut > 0);
  assert.deepEqual(after.slice(0, cut), input.slice(0, cut));
  assert.deepEqual(after.filter(item => item.type === "function_call_output").map(item => item.call_id),
    f.active.map(call => call.id));
  assert.equal(projected.filter(message => message.metisDerived?.kind === "condense-chain").length, 1);
  assert.equal(f.calls.length, 0);
});

test("reload preserves payback; only a repaid rewrite or the pre-Native emergency band permits another", async t => {
  for (const mode of ["unchanged", "reload", "repaid then reload", "emergency", "native handoff"]) await t.test(mode, async t => {
    const capacity = mode === "emergency" || mode === "native handoff";
    const f = await fixture(t, { pruneOn: "on-demand", autoBudgetThreshold: null, capacity,
      spillThreshold: 300000, frontierGapThresholdTokens: null, budgetTurnDelta: null,
      chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: false } });
    Object.assign(f.ctx.model, { cost: { input: 10, output: 0, cacheRead: 1, cacheWrite: 10 } });
    let tokens = 56000;
    f.ctx.getContextUsage = () => ({ tokens, contextWindow: 100000 });
    const log = (size, prefix = "value") => `${prefix}_0123456789 = 0xabcdef123456;\n`.repeat(Math.ceil(4 * size / 32));
    const observe = async (input, cacheRead) => {
      const message = { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
        timestamp: f.nextTimestamp(), stopReason: "stop", content: [{ type: "text", text: "Main reply" }],
        usage: { ...usage, input, cacheRead } };
      await f.emit("message_end", { message });
      f.sm.appendMessage(message);
    };
    const user = content => f.sm.appendMessage({ role: "user", content, timestamp: f.nextTimestamp() });
    const add = (name, size) => { user(name); return f.add(log(size, name), "inspect-source", name); };
    const visible = async () => {
      const raw = f.sm.buildSessionProjection().messages;
      return (await f.emit("context", { messages: raw }))?.messages ?? raw;
    };
    const settle = async () => { await f.emit("agent_settled"); await f.waitMaintenance(); };
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: log(21000) }],
      stopReason: "stop", timestamp: f.nextTimestamp() });
    for (let i = 0; i < 3; i++) await observe(1120, 54880);
    const first = add("earlier", 32000);
    await observe(1120, 54880);
    user("Next task");
    await settle();
    const initial = await visible();
    assert.ok(!initial.some(message => message.toolCallId === first.id), JSON.stringify(f.notices));
    const count = messages => messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    const after = count(initial);
    await observe(after, 0);
    if (mode === "repaid then reload") {
      for (let i = 0; i < 8; i++) await observe(after * 0.02, after * 0.98);
    }
    if (mode.endsWith("reload")) await f.emit("session_start");
    const second = add("later", 32000);
    await f.emit("turn_end", { message: second.assistant, toolResults: [second.result], turnIndex: 1 });
    await f.waitMaintenance();
    for (let i = 0; i < 3; i++) await observe(1200, 58800);
    user("Following task");
    if (capacity) {
      f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: log(mode === "emergency" ? 26000 : 31000) }],
        stopReason: "stop", timestamp: f.nextTimestamp() });
      tokens = count(await visible());
      assert.ok(tokens >= 99500 - 16384, `capacity band ${tokens}`);
      assert.equal(tokens >= 99500 * 0.9, mode === "native handoff", `capacity band ${tokens}`);
    }
    await settle();
    const next = await visible();
    assert.ok(!next.some(message => message.toolCallId === first.id));
    const shouldPublish = mode === "repaid then reload" || mode === "emergency";
    assert.equal(next.some(message => message.toolCallId === second.id), !shouldPublish);
    assert.equal(f.calls.length, 0);
  });
});

test("a suffix archive failure does not block an already-approved earlier rewrite", async t => {
  const f = await independentTasks(t, { total: 240000, sizes: [49000, 31000, 2500, 2500, 2500, 2500],
    perTurn: 8500, price: 20 });
  const [earlier, later] = f.tasks;
  const append = f.sm.appendCustomEntry.bind(f.sm);
  let rejected = false;
  t.mock.method(f.sm, "appendCustomEntry", (type, data) => {
    if (type === "context-prune-index" && data.backfilled && data.toolCalls.some(call => call.toolCallId === later.id)) {
      rejected = true;
      throw new Error("fixture: suffix index write fails");
    }
    return append(type, data);
  });
  await f.emit("agent_settled"); await f.waitMaintenance();
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  assert.ok(rejected, "the suffix staging was attempted");
  assert.ok(!projected.some(message => message.toolCallId === earlier.id), "the earlier replacement still publishes");
  assert.deepEqual(projected.find(message => message.toolCallId === later.id), later.result);
  assert.equal(f.calls.length, 0);
});

test("a packed batch uses the earlier committed cut instead of paying for a separate rewrite", async t => {
  const f = await fixture(t, { batchingMode: "turn", autoBudgetThreshold: null, chainCompression: { enabled: false } });
  f.ctx.getContextUsage = () => undefined;
  Object.assign(f.ctx.model.cost, { input: 3, cacheRead: 1, cacheWrite: 3 });
  const receipt = { ...usage, input: 500, cacheRead: 24500 };
  for (let i = 0; i < 3; i++) await f.emit("message_end", { message: {
    role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id, content: [],
    stopReason: "stop", timestamp: f.nextTimestamp(), usage: receipt,
  } });
  const log = (name, lines) => Array.from({ length: lines }, (_, i) => `built ${name} item ${i}: ${"x".repeat(48)}`).join("\n");
  const first = f.add(log("early", 620), "npm run build", "batch-early");
  const second = f.add(log("late", 95), "npm run build", "batch-later");
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "unchanged tail ".repeat(2250) }],
    stopReason: "stop", timestamp: f.nextTimestamp() });
  await f.finish(true, receipt);
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  for (const call of [first, second])
    assert.match(projected.find(message => message.toolCallId === call.id).content[0].text, /^\[Captured /);
  assert.equal(projected.filter(message => message.details?.representation === "packed").length, 2);
  assert.equal(f.calls.length, 0);
});

test("remote and bounded Responses cache credit require an observed request and matching namespace", async t => {
  for (const mode of ["legacy remote", "Responses remote", "Responses plain"])
    for (const scenario of ["no request evidence", "matching", "changed prompt", "changed tool"])
    await t.test(`${mode}: ${scenario}`, async t => {
      const f = await independentTasks(t, { total: 128000, sizes: [32000], price: 20 });
      if (mode.startsWith("Responses")) {
        f.ctx.model.api = "openai-responses";
        f.ctx.model.compat = { ...f.ctx.model.compat, supportsExplicitPromptCacheMode: true };
      }
      if (mode !== "Responses plain") {
        const first = f.sm.getBranch().find(entry => entry.type === "message");
        f.sm.appendCompaction("Remote history checkpoint", first.id, 128000, { metisCodexRemoteCompaction: { version: 2 } });
      }
      await f.emit("session_start");
      f.ctx.getContextUsage = () => ({ tokens: 128000, contextWindow: 2000000 });
      for (let i = 0; i < 3; i++) {
        if (scenario !== "no request evidence") {
          const raw = f.sm.buildSessionProjection().messages;
          const sent = (await f.emit("context", { messages: raw }))?.messages ?? raw;
          await f.emit("before_provider_request", { payload: { model: f.ctx.model.id, instructions: f.ctx.getSystemPrompt(),
            input: sent.map(message => ({ role: "user", content: JSON.stringify(message) })) } });
        }
        const message = { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
          content: [{ type: "text", text: "Main request completed after recovery" }], stopReason: "stop",
          timestamp: f.nextTimestamp(), usage: { ...usage, input: 2560, cacheRead: 125440 } };
        await f.emit("message_end", { message }); f.sm.appendMessage(message);
      }
      if (scenario === "changed prompt") f.ctx.getSystemPrompt = () => "New system prompt";
      if (scenario === "changed tool") {
        const tool = f.tools.get("context_tree_query");
        f.pi.registerTool({ ...tool, description: tool.description + " Changed schema contract." });
      }
      await f.emit("agent_settled"); await f.waitMaintenance();
      const published = scenario === "matching";
      assert.equal(f.sm.getBranch().filter(entry => entry.customType === "context-prune-chain").length, published ? 1 : 0);
      const raw = f.sm.buildSessionProjection().messages;
      const visible = (await f.emit("context", { messages: raw }))?.messages ?? raw;
      if (published) assert.ok(!visible.some(message => message.toolCallId === f.tasks[0].id));
      else assert.deepEqual(visible.find(message => message.toolCallId === f.tasks[0].id), f.tasks[0].result);
      assert.equal(f.calls.length, 0);
    });
});

test("scoped rewrites and shared fallback both include eligible later chains", async t => {
  for (const scenario of [
    { total: 1000000, sizes: [32000, 6000], price: 10 },
    { total: 1000000, sizes: [300000, 6000], price: 10 },
    { total: 300000, sizes: Array(30).fill(5000), price: 5 },
    { total: 110000, sizes: Array(4).fill(10000), perTurn: 12000, price: 20 },
  ]) await t.test(`${scenario.sizes.length} chains at ${scenario.price}:1`, async t => {
    const f = await independentTasks(t, scenario);
    await f.emit("agent_settled"); await f.waitMaintenance();
    const entries = f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
    assert.equal(entries.length, 1);
    const projected = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
    assert.ok(!projected.some(message => message.toolCallId === f.tasks.at(-1).id),
      "the last closed candidate joins even if it cannot pay for an independent rewrite");
    assert.equal(projected.filter(message => message.metisDerived?.kind === "condense-chain").length, 1);
    assert.equal(f.calls.length, 0);
  });
});

test("pending publication yields to Native pressure even after generation and remains manually recoverable", async t => {
  const f = await fixture(t, { capacity: true, defer: true });
  f.ctx.model.contextWindow = 1000000;
  let tokens = 750000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: f.ctx.model.contextWindow });
  f.add("semantic source ".repeat(2000), "unknown-command");
  const pending = f.finish(false);
  await waitForSummarizer(f);
  tokens = 899550; // 90% of the effective 999500-token Native threshold.
  f.release();
  await pending;
  const summaries = () => f.sm.getBranch().filter(e => e.customType === "context-prune-summary");
  assert.equal(summaries().length, 0, "a completed paid request does not authorize publishing across Native ownership");
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.reason, "deferred-native");
  const raw = f.sm.buildSessionProjection().messages;
  const expected = structuredClone(raw);
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  assert.deepEqual(projected, expected, "retry preserves the entire model-facing prefix");
  assert.equal(f.calls.length, 1, "re-entry must not start another paid summary");
  const manual = f.commands.get("pruner").handler("now", f.ctx);
  await waitForSummarizer(f, 2);
  f.releaseAll();
  await manual;
  assert.ok(summaries().length > 0, "explicit manual pruning still has its original authority");
});

test("automatic chain payback waits for three matching high-cache main requests, not historical spending", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", chainCompression: { enabled: true, rollingWindow: 0 } });
  Object.assign(f.ctx.model, { contextWindow: 1000000, cost: { input: 2, output: 0, cacheRead: 1, cacheWrite: 0 } });
  addClosedChains(f, "Intermediate evidence retained by the existing task summary. ".repeat(12000));
  f.sm.appendMessage({ role: "user", content: "Keep these original requirements. ".repeat(2500), timestamp: f.nextTimestamp() });
  const blocks = () => f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
  await f.emit("agent_settled"); await f.waitMaintenance();
  assert.equal(blocks().length, 0, "a material plan does not invent cache stability before main request receipts");
  const receipt = provider => ({ role: "assistant", api: f.ctx.model.api, provider, model: f.ctx.model.id,
    content: [{ type: "text", text: "Main request complete" }], stopReason: "stop", timestamp: f.nextTimestamp(),
    usage: { ...usage, cacheRead: 200000, cost: { ...usage.cost, cacheRead: 0.2 } } });
  await f.emit("message_end", { message: receipt("different-provider") });
  await f.emit("agent_settled"); await f.waitMaintenance();
  assert.equal(blocks().length, 0, "an unrelated provider receipt cannot establish cache stability");
  for (let i = 0; i < 3; i++) {
    const message = receipt(f.ctx.model.provider);
    await f.emit("message_end", { message }); f.sm.appendMessage(message);
    await f.emit("agent_settled"); await f.waitMaintenance();
    assert.equal(blocks().length, i === 2 ? 1 : 0, "only the third qualifying main request completes warmup");
  }
  assert.equal(blocks().length, 1, "a large mechanically retained group passes payback after cache warmup");
  assert.equal(blocks()[0].data.kind, "shared-v1");
  assert.equal(f.calls.length, 0);
});

test("automatic chain compression follows its switch and retains three recent tasks with exact recovery", async (t) => {
  for (const enabled of [false, true])
    await t.test(`enabled=${enabled}`, async (t) => {
      const f = await fixture(t, { mode: "tui", chainCompression: { enabled, rollingWindow: 3, fuseRangeSummary: false } });
      const body = "first task evidence\n".repeat(1400);
      for (let i = 0; i < 4; i++) {
        if (i) f.sm.appendMessage({ role: "user", content: `Task ${i}`, timestamp: f.nextTimestamp() });
        f.add(body, "cat evidence.txt", `chain-${i}`, `THOUGHT_${i} ` + "x".repeat(5000));
        if (i === 0) {
          f.sm.appendMessage({
            role: "assistant",
            timestamp: f.nextTimestamp(),
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "protected-receipt", name: "subagents_spawn_agent", arguments: { task: "Inspect" } },
            ],
          });
          f.sm.appendMessage({
            role: "toolResult",
            timestamp: f.nextTimestamp(),
            toolCallId: "protected-receipt",
            toolName: "subagents_spawn_agent",
            content: [{ type: "text", text: "PROTECTED_RECEIPT_VERBATIM" }],
            isError: false,
          });
        }
        await f.finish();
      }
      const chains = () => f.sm.getBranch().filter((e) => e.customType === "context-prune-chain");
      assert.equal(chains().length, enabled ? 1 : 0, "the fourth closing message counts before Pi persists it");
      assert.equal(f.notices.filter(([message]) => /compacted 1 chain/.test(message)).length, enabled ? 1 : 0,
        "automatic maintenance announces only newly published chains");
      const original = f.sm.buildSessionProjection().messages;
      const projected = (await f.emit("context", { messages: original })).messages;
      const text = JSON.stringify(projected);
      assert.equal(text.includes("THOUGHT_0"), !enabled);
      for (let i = 1; i < 4; i++) assert.match(text, new RegExp(`THOUGHT_${i}`));
      assert.match(text, /PROTECTED_RECEIPT_VERBATIM/);
      assert.equal(projected.filter((m) => m.role === "user").length, enabled ? 5 : 4);
      assert.equal(
        projected.filter((m) => m.role === "assistant" && m.content.some((b) => b.text === "Final reply")).length,
        4,
      );
      const recalled = await f.tools
        .get("context_tree_query")
        .execute("q", { toolCallIds: ["chain-0"] }, undefined, undefined, f.ctx);
      assert.equal(recalled.details.results[0].text, body);
      const noticeCount = f.notices.length;
      await f.emit("session_start");
      assert.deepEqual((await f.emit("context", { messages: original })).messages, projected);
      await f.finish();
      assert.equal(f.notices.length, noticeCount, "reload/revalidation cannot announce already committed actions again");
      assert.equal(chains().length, enabled ? 1 : 0);
      assert.equal(
        f.calls.length,
        1,
        "dedup and chain compression reuse the durable summary without another model call",
      );
    });
});

test("automatic chain compression archives skipped small outputs and preserves them on persistence failures", async (t) => {
  for (const failure of [undefined, "chain", "archive"])
    await t.test(failure ?? "mixed coverage", async (t) => {
      const f = await fixture(t, { chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: false } });
      const call = f.add(
        buildLog,
        "npm run build",
        "mixed-large",
        "Retain intermediate reasoning until a durable replacement exists. ".repeat(100),
      );
      const small = f.add("UNSUMMARIZED_EVIDENCE", "cat small.txt");
      if (failure) {
        const append = f.sm.appendCustomEntry.bind(f.sm);
        f.sm.appendCustomEntry = (type, data) => {
          if (
            (failure === "chain" && type === "context-prune-chain") ||
            (failure === "archive" &&
              type === "context-prune-index" &&
              data.backfilled &&
              data.toolCalls.some((call) => call.toolCallId === small.id))
          )
            throw new Error("chain disk failure");
          return append(type, data);
        };
      }
      await f.finish();
      f.sm.appendMessage({ role: "user", content: "Continue with another build", timestamp: f.nextTimestamp() });
      const progress = f.add(buildLog, "npm run build");
      await f.emit("turn_end", { message: progress.assistant, toolResults: [progress.result] });
      await f.waitMaintenance();
      assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-chain").length, failure ? 0 : 1);
      assert.ok(
        f.sm.getBranch().some((e) => e.details?.representation === "packed"),
        "the successful summary remains persisted",
      );
      const projected = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
      if (failure)
        assert.match(JSON.stringify(projected), /UNSUMMARIZED_EVIDENCE/, "archiving alone cannot hide raw output");
      if (failure !== "archive")
        assert.equal(
          (
            await f.tools
              .get("context_tree_query")
              .execute("q", { toolCallIds: [small.id] }, undefined, undefined, f.ctx)
          ).details.results[0].text,
          "UNSUMMARIZED_EVIDENCE",
        );
      assert.equal(
        (await f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id] }, undefined, undefined, f.ctx))
          .details.results[0].text,
        buildLog,
      );
    });
});

test("automatic chain compression reuses durable summaries without a second paid fusion", async (t) => {
  const f = await fixture(t, { chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  for (let i = 0; i < 25; i++) f.add(`evidence-${i}\n` + (i === 24 ? "界" : "x").repeat(6000), `cat evidence-${i}.txt`);
  await f.finish();
  assert.equal(f.calls.length, 2);
  assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-summary").length, 2);
  assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-chain").length, 0,
    "batch and chain rewrites cannot spend the same growth twice");
  f.sm.appendMessage({ role: "user", content: "Continue with another build", timestamp: f.nextTimestamp() });
  const progress = f.add(buildLog, "npm run build");
  await f.emit("turn_end", { message: progress.assistant, toolResults: [progress.result] });
  await f.waitMaintenance();
  assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-chain").length, 1);
  await f.emit("session_tree");
  await f.finish(false);
  assert.equal(f.calls.length, 2, "reload cannot turn mechanical chain compression into paid fusion");
});

for (const boundary of ["settled", "session_tree", "session_start", "session_shutdown"])
  test(`final boundary retains refs and discards late summaries after ${boundary}`, async (t) => {
    const f = await fixture(t, { reply: "A short useful summary with no reference labels.", defer: true });
    const call = f.add("important detail\n".repeat(1500), "inspect-unknown-tool");
    const pending = f.finish();
    for (let i = 0; i < 600 && f.calls.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.calls.length, 1);
    const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()) };
    f.events.emit("metis:condense-project", request);
    assert.equal(request.busy, true);
    if (boundary !== "settled") await f.emit(boundary);
    f.release();
    await pending;
    const summary = f.sm
      .getBranch()
      .find((e) => e.type === "custom_message" && e.details?.representation === "summary");
    if (boundary !== "settled") {
      assert.equal(summary, undefined);
      const messages = projectBranchMessages(f.sm.getBranch());
      assert.equal(
        messages.find((message) => message.toolCallId === call.id).content[0].text,
        "important detail\n".repeat(1500),
      );
      return;
    }
    assert.ok(summary);
    assert.match(summary.content, /t1/);
    assert.equal(summary.details.toolCallRefs.length, 1);
    const recall = await f.tools
      .get("context_tree_query")
      .execute("q", { toolCallIds: ["t1"] }, undefined, undefined, f.ctx);
    assert.equal(recall.details.results[0].text, "important detail\n".repeat(1500));
    await f.finish();
    assert.equal(f.calls.length, 1, "same history is not summarized again");
    const source = f.sm
      .getBranch()
      .find(
        (entry) =>
          entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id,
      );
    f.sm.appendContextEdit(source.id, { content: "CORRECTED_WITHOUT_OCC" });
    const effective = f.sm.buildSessionProjection().messages;
    const edited = (await f.emit("context", { messages: effective }))?.messages ?? effective;
    assert.match(JSON.stringify(edited), /CORRECTED_WITHOUT_OCC/);
    assert.ok(
      !edited.some((message) => message.customType === "context-prune-summary"),
      "edited source invalidates its derived summary even without OCC",
    );
  });

test("session restore drops the previous queue while a tree switch keeps its own records and never reloads config", async (t) => {
  const f = await fixture(t, { mode: "tui" });
  // A body that reaches the summarizer (buildLog packs into an archive instead).
  const body = "important detail\n".repeat(1500);
  // agent-message queues this batch and returns before the budget gate.
  const queued = f.add(body, "inspect-unknown-tool");
  await f.emit("turn_end", { message: queued.assistant, toolResults: [queued.result], turnIndex: 0 });
  assert.equal(f.calls.length, 0);

  // session_start reloads config from disk and boots the status + boot widget.
  const settings = { contextPrune: {
    enabled: true, showPruneStatusLine: true, minBatchChars: 5000, pruneOn: "on-demand", batchingMode: "agent-message",
    autoBudgetThreshold: 0.7, budgetTurnDelta: 0.2, frontierGapThresholdTokens: 1,
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true, minRecentTokens: 0, minWorkTurns: 0 },
    purgeErrors: { enabled: false },
  } };
  writeFileSync(join(f.dir, "metis-pi.toml"), stringify(settings));
  await f.emit("session_start");
  assert.deepEqual(f.widgets.filter(([id]) => id === "pruner-boot").map(([, value]) => value.length), [1]);
  assert.match(f.statuses.get("context-prune"), /prune: ON/);
  assert.match(f.statuses.get("context-prune"), /\n.*recovered.*current branch/i);

  // The reload re-armed this branch; a successful response must consume the
  // restored output before its budget-triggered summary can replace the raw body.
  await f.finish(false);
  await f.emit("turn_end", {});
  assert.equal(f.calls.length, 1);
  assert.ok(!f.notices.some(([message]) => /compacting work recovered after reload/.test(message)),
    "a pre-flush pressure hint belongs in TUI details, not ordinary chat");
  const summary = f.sm
    .getBranch()
    .find((entry) => entry.type === "custom_message" && entry.details?.representation === "summary");
  assert.ok(summary, "the restored index publishes a summary for the current branch");
  const recall = await f.tools
    .get("context_tree_query")
    .execute("q", { toolCallIds: [queued.id] }, undefined, undefined, f.ctx);
  assert.equal(recall.details.results[0].text, body);

  // A tree switch rebuilds the same records without re-summarizing indexed work,
  // re-arms work that only this branch holds, and (unlike session_start) neither
  // reloads config nor shows the boot widget.
  writeFileSync(
    join(f.dir, "metis-pi.toml"),
    stringify({ ...settings, contextPrune: { ...settings.contextPrune, showPruneStatusLine: false } }),
  );
  const afterBody = "later detail\n".repeat(3200);
  f.add(afterBody, "inspect-after-tree");
  await f.emit("session_tree");
  assert.match(f.statuses.get("context-prune"), /\n.*recovered.*current branch/i);
  const raw = f.sm.buildSessionProjection().messages;
  const sent = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  await f.finish(false, { ...usage, input: sent.reduce((sum, message) => sum + estimateTokens(message), 0) });
  await f.emit("turn_end", {});
  assert.equal(f.calls.length, 2, "the tree probe re-arms only this branch's unindexed work");
  assert.equal(f.widgets.filter(([id]) => id === "pruner-boot").length, 1);
  assert.match(f.statuses.get("context-prune"), /prune: ON/, "session_tree keeps the loaded config");
  await f.emit("session_tree");
  assert.match(f.statuses.get("context-prune"), /\nNo pending turns$/,
    "branch restore derives current work rather than restoring an old completion or queue detail");
});

test("nested results retain prepared arguments, structured output and denied evidence across reload", async t => {
  const f = await fixture(t), body = "exact child output\n".repeat(350);
  const parent = f.add("native presentation", "", "nested-parent");
  parent.assistant.content[0].name = parent.result.toolName = "codemode";
  await f.emit("tool_execution_start", { toolCallId: "nested-read", parentToolCallId: parent.id, toolName: "read", args: { path: "draft" } });
  await f.emit("tool_call", { toolCallId: "nested-read", toolName: "read", input: { path: "skills/example/SKILL.md" } });
  await f.emit("tool_execution_end", { toolCallId: "nested-read", parentToolCallId: parent.id, toolName: "read", isError: false,
    result: { content: [{ type: "text", text: body }], structuredContent: { complete: true }, details: {} } });
  await f.emit("tool_execution_start", { toolCallId: "nested-denied", parentToolCallId: parent.id, toolName: "bash", args: { command: "denied" } });
  await f.emit("tool_execution_end", { toolCallId: "nested-denied", parentToolCallId: parent.id, toolName: "bash", isError: true,
    result: { content: [{ type: "text", text: "Permission denied" }], details: {} } });
  Object.assign(parent.result, await f.emit("tool_result", parent.result));
  assert.equal(parent.result.details.metisNested.protected, true);
  assert.equal(parent.result.details.metisNested.hasError, true);
  assert.equal(parent.result.details.metisNested.archiveFailed, false);
  await f.emit("tool_execution_end", { toolCallId: parent.id, result: parent.result });
  await f.finish();
  assert.equal(f.calls.length, 0, "protected child evidence keeps its parent out of local summaries");
  await f.emit("session_start");
  const query = (params) =>
    f.tools
      .get("context_tree_query")
      .execute("q", { parentToolCallId: parent.id, maxBytes: 32768, ...params }, undefined, undefined, f.ctx);
  const recalled = (await query({})).details.results;
  assert.equal(recalled.length, 2);
  assert.equal(recalled.find((r) => r.tool === "read").text, body + '\n\n[Structured content]\n{"complete":true}');
  assert.equal(recalled.find((r) => r.tool === "bash").status, "ERROR");
  assert.match(JSON.stringify((await query({ component: "arguments" })).details), /skills\/example\/SKILL.md/);
});

for (const eager of [true, false])
  test(`fused evidence preserves mutation, packs only successful logs and reloads exact output; turn_end=${eager}`, async (t) => {
    const f = await fixture(t, { mode: "tui" });
    const path = join(f.dir, "fused-command.log");
    writeFileSync(path, buildLog);
    const prefix = `Updated file.ts\n+saved\nCommand succeeded; log ${path}`;
    const call = f.add("unused", "npm run build", "fused-write");
    call.assistant.content[0].name = "write";
    call.assistant.content[0].arguments = { path: "file.ts", content: "saved", then_run: { command: "npm run build" } };
    call.result.toolName = "write";
    call.result.content = [
      { type: "text", text: prefix },
      { type: "text", text: buildLog },
    ];
    call.result.details = {
      metisActionFusion: {
        version: 1,
        mutationStatus: "success",
        command: {
          command: "npm run build",
          status: "succeeded",
          exitCode: 0,
          outputBlock: 1,
          fullOutputPath: path,
          fullOutputBytes: Buffer.byteLength(buildLog),
          fullOutputComplete: true,
        },
      },
    };
    if (eager) await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
    await f.finish();
    assert.equal(f.calls.length, 0);
    assert.equal(f.notices.length, 1, "eager and flush-time recovery stubs each announce only their committed rewrite");
    assert.match(f.notices[0][0], /pruned 1 tool output.*recovery stubs/);
    const query = () =>
      f.tools
        .get("context_tree_query")
        .execute("q", { toolCallIds: [call.id], maxBytes: 32768 }, undefined, undefined, f.ctx);
    assert.equal((await query()).details.results[0].text, `${prefix}\n${buildLog}`);
    await f.emit("session_start");
    assert.equal((await query()).details.results[0].text, `${prefix}\n${buildLog}`);
    const live = (await f.emit("context", { messages: projectBranchMessages(f.sm.getBranch()) })).messages;
    const visible = live
      .find((message) => message.role === "toolResult" && message.toolCallId === call.id)
      .content.map((block) => block.text ?? "")
      .join("\n");
    assert.match(visible, /Updated file.ts\n\+saved/);
    assert.match(visible, /lines omitted/);
    assert.match(visible, /BUILD COMPLETE/);
    assert.match(visible, /fused-command.log/);
    assert.equal(f.notices.length, 1, "reload does not reannounce historical recovery stubs");
  });

test("goal continuation counters change only the appended message, preserving system instructions", async (t) => {
  const hooks = new Map(),
    tools = new Map();
  const sm = SessionManager.inMemory("/tmp/goal-prefix");
  const pi = {
    events: createEventBus(),
    on: (name, fn) => hooks.set(name, fn),
    registerCommand() {},
    registerTool: (t) => tools.set(t.name, t),
    registerMessageRenderer() {},
    appendEntry: (type, data) => sm.appendCustomEntry(type, data),
    sendMessage() {},
  };
  goalExtension(pi);
  const ctx = { sessionManager: sm, hasUI: false, isIdle: () => true, hasPendingMessages: () => false };
  t.after(() => hooks.get("session_shutdown")({}, ctx));
  await tools
    .get("goal")
    .execute("c", { action: "create", objective: "Finish local work", token_budget: 10000 }, undefined, undefined, ctx);
  const beforeEvent = { systemPromptOptions: { sections: { docs: "FIXED" } } };
  const before = await hooks.get("before_agent_start")(beforeEvent, ctx);
  await hooks.get("agent_start")({}, ctx);
  await hooks.get("agent_end")(
    { messages: [{ role: "assistant", stopReason: "stop", usage, content: [{ type: "text", text: "Continue" }] }] },
    ctx,
  );
  const afterEvent = { systemPromptOptions: { sections: { docs: "FIXED" } } };
  const after = await hooks.get("before_agent_start")(afterEvent, ctx);
  assert.deepEqual(beforeEvent.systemPromptOptions, afterEvent.systemPromptOptions);
  assert.match(afterEvent.systemPromptOptions.sections.metis_goal, /Finish local work/);
  assert.notEqual(before.message.content, after.message.content);
  assert.match(after.message.content, /Tokens used: 20/);
});


test("manual paid fusion budgets the full chain wrapper and retains concatenation on rejection", async t => {
  for (const rejected of [false, true]) await t.test(rejected ? "budget rejected" : "accepted", async t => {
    const f = await fixture(t, { mode: "tui", reply: n => n <= 2 ? "界".repeat(2500) : rejected ? "界".repeat(3500) : "Fused evidence.",
      chainCompression: { enabled: true, rollingWindow: 100, fuseRangeSummary: true } });
    for (let i = 0; i < 26; i++) f.add(`evidence-${i}\n` + "界 ".repeat(3000), `cat evidence-${i}.txt`);
    await f.finish();
    assert.equal(f.calls.length, 2);
    assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-chain"));
    await f.commands.get("pruner").handler("compact", f.ctx);
    assert.ok(f.notices.some(([message, type]) => /pruner: compacted 1 chain/.test(message) && type === "info"),
      "actual chain compaction still reports its action in the TUI");
    assert.equal(f.calls.length, 3);
    const chain = f.sm.getBranch().find(e => e.customType === "context-prune-chain").data;
    assert.equal(chain.rangeSummaryText, rejected ? undefined : "Fused evidence.");
    assert.ok((await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages
      .some(m => m.metisDerived?.blockId === chain.blockId));
  });
});

test("automatic batch rewrites cannot buy small savings by chilling a long suffix; manual still works", async t => {
  for (const packed of [false, true]) await t.test(packed ? "packed" : "semantic", async t => {
    const f = await fixture(t);
    f.ctx.model.cost = { input: 10, output: 1, cacheRead: 1, cacheWrite: 1 };
    const responseUsage = { ...usage, input: 10, cacheRead: 90000 };
    for (let i = 0; i < 3; i++) await f.emit("message_end", { message: {
      role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
      content: [{ type: "text", text: "Main request complete" }], stopReason: "stop",
      timestamp: f.nextTimestamp(), usage: responseUsage,
    } });
    const call = f.add(packed ? buildLog : "Important evidence remains available. ".repeat(1500),
      packed ? "npm run build" : "inspect-unknown-tool");
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Unchanged suffix. ".repeat(12000) }],
      timestamp: f.nextTimestamp(), stopReason: "stop" });
    await f.finish(true, responseUsage);
    assert.equal(f.calls.length, 0, "reject the optimistic cache cost before paying a summary model");
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 0);
    const metric = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
    assert.equal(metric.deferredReasons.economics, 1);
    const raw = f.sm.buildSessionProjection().messages;
    const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
    assert.deepEqual(projected.find(m => m.toolCallId === call.id), call.result);
    await f.commands.get("pruner").handler("now", f.ctx);
    assert.equal(f.calls.length, packed ? 0 : 1, "explicit manual pruning retains its existing authority");
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 1);
  });
});

test("automatic summary admission includes request caps and charged attempts, without treating economic refusal as an outage", async t => {
  const billed = { ...usage, cost: { ...usage.cost, total: 10 } };
  const f = await fixture(t, { summaryUsage: billed });
  f.add("Keep these observations. ".repeat(2000), "inspect-source");
  const summaryModel = f.ctx.modelRegistry.find();
  summaryModel.cost.output = 1000000;
  await f.finish();
  assert.equal(f.calls.length, 0, "reject unaffordable output ceilings before the native provider starts");
  summaryModel.cost.output = 0.01;
  await f.finish();
  assert.equal(f.calls.length, 1, "an affordable estimate permits real provider work");
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 0,
    "the actual receipt is checked before publishing, even when it exceeds the estimate");
  await f.finish();
  assert.equal(f.calls.length, 1, "a failed publication does not refund the paid request on the next retry");
  assert.ok(!f.notices.some(([message]) => /failing, using|summarization failed/.test(message)));
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 1);
});

test("neither the publishing final nor the cold request counts toward the next three high-cache main requests", async t => {
  const f = await fixture(t);
  f.ctx.model.cost = { input: 2, output: 0, cacheRead: 1, cacheWrite: 0 };
  const responseUsage = { ...usage, input: 10, cacheRead: 90000 };
  const complete = async () => {
    const message = { role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
      content: [{ type: "text", text: "Main request complete" }], stopReason: "stop",
      timestamp: f.nextTimestamp(), usage: responseUsage };
    await f.emit("message_end", { message }); f.sm.appendMessage(message);
  };
  for (let i = 0; i < 3; i++) await complete();
  f.add("First evidence to summarize. ".repeat(1800), "inspect-first");
  await f.finish(true, responseUsage);
  const summaries = () => f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length;
  assert.equal(summaries(), 1);
  f.add("Second useful evidence. ".repeat(1800), "inspect-second");
  for (let i = 0; i < 4; i++) {
    await complete();
    assert.equal(summaries(), i < 3 ? 1 : 2,
      "cold rebuild precedes three new successful main requests; publishing finals and summary receipts are not reuse");
  }
});

test("a second small automatic batch waits for useful growth, not another final or context callback", async t => {
  const f = await fixture(t, { chainCompression: { minGainTokens: 10000 } });
  f.add("First useful evidence. ".repeat(1600), "inspect-first");
  await f.finish();
  assert.equal(f.calls.length, 1);
  const next = f.add("Second useful evidence. ".repeat(1600), "inspect-second");
  await f.finish();
  const raw = f.sm.buildSessionProjection().messages;
  await f.emit("context", { messages: raw });
  assert.equal(f.calls.length, 1, "callbacks do not count as new useful work");
  assert.deepEqual((await f.emit("context", { messages: raw })).messages.find(m => m.toolCallId === next.id), next.result);
  f.add("New completed useful work. ".repeat(7000), "inspect-more-work");
  await f.finish();
  assert.ok(f.calls.length > 1, "enough completed work reopens automatic admission");
});

test("pressure deferral keeps a frontier gap, permits packing and retries on the next real context", async t => {
  const f = await fixture(t);
  f.ctx.getContextUsage = () => ({ tokens: 60000, contextWindow: 100000 });
  const semantic = f.add("界".repeat(6000), "unknown-command", "deferred");
  await f.finish();
  assert.equal(f.calls.length, 0);
  const metrics = f.sm.getBranch().findLast((e) => e.customType === "context-prune-flush-metrics").data;
  assert.equal(metrics.outcome, "deferred");
  assert.deepEqual(metrics.deferredReasons, { pressure: 1 });
  assert.equal(metrics.error, undefined);
  f.add(buildLog);
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.ok(f.sm.getBranch().some((e) => e.details?.representation === "packed"));
  assert.ok(
    !f.sm.getBranch().some((e) => e.customType === "context-prune-frontier"),
    "later packing cannot cross a deferred semantic gap",
  );
  f.ctx.getContextUsage = () => ({ tokens: 75000, contextWindow: 100000 });
  const fresh = f.add("Current task still needs this raw evidence. ".repeat(1000), "unknown-command", "fresh-round");
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw })).messages;
  assert.deepEqual(projected.find(m => m.toolCallId === fresh.id), fresh.result,
    "retrying an older final cannot summarize a new tool result before the main model sees it");
  assert.equal(f.calls.length, 1);
  assert.ok(
    projected.some((m) => m.customType === "context-prune-summary" && m.details?.representation === "summary"),
    "this request includes the just-persisted summary",
  );
  assert.notEqual(projected.find((m) => m.toolCallId === semantic.id).content[0].text, semantic.result.content[0].text);
  await f.emit("context", { messages: projected });
  assert.equal(f.calls.length, 1, "repeated projection does not regenerate completed evidence");
});

test("complete-message budgets include refs, reject without hiding and charge reported rejected output", async (t) => {
  const encoder = new TokenEstimator();
  t.after(() => encoder.clear());
  let badReply;
  const f = await fixture(t, {
    showPruneStatusLine: true,
    mode: "tui",
    quietOversizedSkips: false,
    reply: (n) => (n === 1 ? badReply : "Inspection complete."),
  });
  const call = f.add("界".repeat(6000), "unknown-command", "full-budget");
  const counts = await encoder.measure([call.result], [toolResultStub(call.result, undefined, "t1")]);
  const budget = summaryBudget(counts.before, counts.after, 1);
  badReply = "界".repeat(budget.limit); // Body alone fits; the real refs/wrapper do not.
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.equal(f.statuses.get("context-prune").split("\n")[0], "│ prune: ON · usage: 20 tokens");
  assert.match(f.statuses.get("context-prune"), /\n.*retained pending.*budget/i);
  assert.deepEqual(f.notices, [], "paid usage alone is not a confirmed prune action");
  assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier" || e.customType === "context-prune-summary"));
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.reason, "deferred-budget");
  assert.equal(f.sm.buildSessionProjection().messages.find(m => m.toolCallId === call.id).content[0].text, call.result.content[0].text);
  const original = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: original })).messages;
  assert.equal(f.calls.length, 2, "next context retries at high pressure and publishes reply 2");
  const summary = f.sm.getBranch().find(e => e.details?.representation === "summary");
  assert.equal(summary.details.toolCallRefs[0].shortId, "t1", "retry reuses the durable source reference");
  const stub = projected.find(m => m.toolCallId === call.id);
  const rendered = await encoder.measure([call.result], [stub, summary]);
  assert.ok(rendered.before - rendered.after >= budget.minimumGain);
  const size = await encoder.measure([summary], []);
  assert.ok(size.before <= budget.limit && size.before <= 6144);
  assert.match(f.statuses.get("context-prune"), /usage: 40 tokens/);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0][0], /pruner: pruned 1 tool batch/);
});

test("short summaries can shrink the soft target without relaxing net gain or the minimum useful body", async t => {
  const encoder = new TokenEstimator();
  t.after(() => encoder.clear());
  for (const [chars, accepted] of [[2600, true], [2300, false]]) await t.test(String(chars), async t => {
    const f = await fixture(t, { minBatchChars: 2000, reply: "Inspection complete." });
    const call = f.add("界".repeat(chars), "unknown-command", `short-budget-${chars}`);
    const counts = await encoder.measure([call.result], [toolResultStub(call.result, undefined, "t1")]);
    const budget = summaryBudget(counts.before, counts.after, 1);
    assert.ok(budget.limit < DEFAULT_CONFIG.summaryBudget.targetBaseTokens + DEFAULT_CONFIG.summaryBudget.targetPerCallTokens);
    await f.finish();
    assert.equal(f.calls.length, Number(accepted));
    const raw = f.sm.buildSessionProjection().messages;
    const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
    if (!accepted) {
      assert.deepEqual(projected.find(message => message.toolCallId === call.id), call.result);
      assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.outcome, "deferred-budget");
      return;
    }
    const summary = projected.find(message => message.customType === "context-prune-summary");
    const stub = projected.find(message => message.toolCallId === call.id);
    assert.ok(summary);
    const rendered = await encoder.measure([call.result], [stub, summary]);
    assert.ok(rendered.before - rendered.after >= budget.minimumGain);
    assert.ok((await encoder.measure([summary], [])).before <= budget.limit);
  });
});

test("global TOML policy governs actual paid summary admission and full-message rejection", async (t) => {
  for (const [size, accepted] of [
    [300, true],
    [1000, false],
  ])
    await t.test(String(size), async (t) => {
      const f = await fixture(t, { reply: "论".repeat(size) });
      writeFileSync(
        join(f.dir, "metis-pi.toml"),
        "[contextPrune]\nenabled=true\nminBatchChars=0\nautoBudgetThreshold=0.7\nsummarizerModel=\"local/cheap-summary\"\n[contextPrun" +
          "e.chainCompression]\nenabled=false\nminRecentTokens=0\nminWorkTurns=0\n[contextPrune.summaryBudget]\nminGainTokens=512" +
          "\nminGainFraction=0.1\nmaxProxyTokens=1000\ntargetBaseTokens=128\ntargetPerCallToken" +
          "s=0\n",
      );
      await f.emit("session_start");
      const call = f.add("甲".repeat(4000), "opaque-command", `toml-${size}`);
      await f.finish();
      assert.equal(f.calls.length, 1, "TOML minBatchChars overrides legacy JSON");
      const raw = f.sm.buildSessionProjection().messages;
      const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
      assert.equal(
        projected.some((message) => message.customType === "context-prune-summary"),
        accepted,
      );
      if (!accepted)
        assert.equal(
          projected.find((message) => message.toolCallId === call.id).content[0].text,
          call.result.content[0].text,
        );
    });
});

test("legacy duplicate evidence never authorizes a growing mechanical stub", async (t) => {
  const f = await fixture(t);
  f.sm.appendCustomEntry("context-prune-index", {
    toolCalls: [
      {
        toolCallId: "legacy-small",
        resultTimestamp: 5,
        toolName: "bash",
        args: { command: "unknown-command" },
        resultText: "OK",
        isError: false,
        turnIndex: -1,
        timestamp: 4,
      },
    ],
  });
  await f.emit("session_start");
  const call = f.add("OK", "unknown-command", "fresh-small");
  await f.finish();
  assert.equal(f.calls.length, 0);
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
  assert.equal(projected.find(m => m.toolCallId === call.id).content[0].text, "OK");
  const stored = f.sm.getBranch().filter(e => e.customType === "context-prune-index")
    .flatMap(e => e.data.toolCalls).find(record => record.toolCallId === call.id);
  assert.equal(stored.archiveOnly, true, "durable recovery metadata alone cannot hide evidence");
});

test("model-facing proxy measurements ignore metadata/timestamps and concurrent jobs all complete", async t => {
  const encoder = new TokenEstimator(); t.after(() => encoder.clear());
  const jobs = Array.from({ length: 8 }, (_, i) => encoder.measure([{ role: "custom", customType: "test", content: "Same evidence.",
    details: { hidden: "x".repeat(i * 1000) }, display: Boolean(i % 2), timestamp: i }], []));
  const results = await Promise.all(jobs);
  assert.ok(results.every(result => result !== null));
  assert.ok(results.every(result => result.before === results[0].before));
  const shared = { role: "user", content: "unchanged evidence ".repeat(500), timestamp: 3 };
  const replacement = { role: "user", content: "compact replacement", timestamp: 4 };
  const before = [shared, shared, { ...shared, content: "distinct evidence" }], after = [shared, replacement];
  const delta = await encoder.compare(before, after), absolute = await encoder.measure(before, after);
  assert.equal(delta.proxyDelta, absolute.before - absolute.after, "shared cancellation retains duplicate multiplicity");
  assert.equal(delta.piBefore, before.reduce((sum, message) => sum + estimateTokens(message), 0));
  assert.equal(delta.piAfter, after.reduce((sum, message) => sum + estimateTokens(message), 0));
  const mutable = { role: "user", content: "request-time evidence", timestamp: 5 };
  const expected = await encoder.measure([mutable], []);
  const pending = encoder.measure([mutable], []);
  mutable.content = "subsequently modified evidence ".repeat(1000);
  assert.equal((await pending).before, expected.before, "encoder work retains request-time text despite later mutation");
  assert.equal(shouldBudgetFlush({ tokens: 67000, contextWindow: 100000 }, 0.7, 83000), true, "native reserve and 16K headroom can admit below 70%");
  assert.equal(shouldBudgetFlush({ tokens: 69999, contextWindow: 100000 }, 0.7), false);
  assert.equal(shouldBudgetFlush({ tokens: 70000, contextWindow: 100000 }, 0.7), true);
  assert.equal(shouldBudgetFlush({ tokens: 300000, contextWindow: 1000000 }, 0.7), true);
  assert.equal(shouldBudgetFlush({ tokens: Infinity, contextWindow: 100000 }, 0.7), false);
  assert.equal(shouldBudgetFlush({ tokens: 90000, contextWindow: 100000 }, null), false);
});

test("minBatchChars is only a character guard; paid summaries must also earn their token budget", async (t) => {
  const f = await fixture(t);
  f.add("界".repeat(4999), "unknown-command", "below"); await f.finish();
  assert.equal(f.calls.length, 0);
  f.add("b".repeat(5000), "unknown-command", "low-proxy-benefit"); await f.finish();
  assert.equal(f.calls.length, 0, "passing the character guard never forces a paid request");
  f.add("界".repeat(5000), "unknown-command", "at-limit"); await f.finish();
  assert.equal(f.calls.length, 1);
});

for (const stopReason of ["error", "length"]) test(`summary ${stopReason} records its cause, retains raw output and can retry`, async t => {
  const f = await fixture(t, { mode: "tui", stopReason });
  const body = "important detail\n".repeat(1800), call = f.add(body, "inspect-unknown-tool");
  await f.finish();
  const metric = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data;
  assert.equal(metric.outcome, "error"); assert.equal(metric.reason, "summarizer-failed");
  assert.match(metric.error, stopReason === "error" ? /Offline summary provider failed/ : /length-truncated/);
  if (stopReason === "error") assert.ok(f.notices.some(([message, type]) => /summarization failed/.test(message) && type === "error"),
    "existing operational errors remain visible in the TUI");
  assert.ok(!f.notices.some(([message]) => /pruner: pruned /.test(message)));
  const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()) };
  f.events.emit("metis:condense-project", request);
  assert.ok(request.messages.some(message => message.toolCallId === call.id && message.content[0].text === body));
  assert.ok(!request.messages.some(message => message.customType === "context-prune-flush-metrics"));
  const attempts = f.calls.length;
  await f.finish(); assert.ok(f.calls.length > attempts, "failed batches remain available for retry, including fallback routes");
});

test("historical oversized frontiers retain their boundary without becoming live flush results", async t => {
  const f = await fixture(t);
  const old = f.add("HISTORICAL_RAW_EVIDENCE ".repeat(1500), "unknown-old-command", "historical-oversized");
  f.sm.appendCustomEntry("context-prune-frontier", {
    lastAttemptedToolCallId: old.id,
    lastAttemptedToolName: "bash",
    lastAttemptedResultTimestamp: old.result.timestamp,
    lastAttemptedTurnIndex: 0,
    lastAttemptedTimestamp: old.assistant.timestamp,
    attemptedBatchCount: 1,
    attemptedToolCallCount: 1,
    rawCharCount: old.result.content[0].text.length,
    summaryCharCount: old.result.content[0].text.length + 100,
    outcome: "skipped-oversized",
  });
  await f.emit("session_start");
  f.add("NEW_PENDING_EVIDENCE ".repeat(1500), "unknown-new-command", "new-pending");
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls[0]).includes("HISTORICAL_RAW_EVIDENCE"), "reload honors the legacy attempted boundary");
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw })).messages;
  assert.deepEqual(projected.find(m => m.toolCallId === old.id).content, old.result.content, "the legacy skip did not authorize hiding raw output");
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.outcome, "summarized");
});

test("failed tree recovery cannot expose the old archive but raw source recall remains available", async t => {
  const f = await fixture(t, { mode: "tui", chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  const root = f.sm.getLeafId();
  f.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: "old-branch", toolName: "read",
    args: { path: "old" }, resultText: "OLD_BRANCH", turnIndex: 0, timestamp: 3, resultTimestamp: 3 }] });
  addClosedChains(f);
  await f.emit("agent_settled"); await f.waitMaintenance();
  await f.emit("session_start");
  await f.commands.get("pruner").handler("thinking low", f.ctx); // Invalidate old published views before the failed restore.
  f.sm.branch(root);
  const source = f.sm.appendMessage({ role: "user", content: "NEW_BRANCH", timestamp: 4 });
  const broken = f.sm.appendCustomEntry("context-prune-index", { toolCalls: [] });
  const getEntry = f.sm.getEntryForScan.bind(f.sm);
  t.mock.method(f.sm, "getEntryForScan", id => {
    if (id === broken) throw new Error("recovery read failed");
    return getEntry(id);
  });
  await assert.rejects(f.emit("session_tree"), /recovery read failed/);
  assert.equal(await f.emit("context", { messages: f.sm.buildSessionProjection().messages }), undefined,
    "a failed owner must not spin a foreground request trying to validate old shared entries");
  const tool = f.tools.get("context_tree_query");
  await assert.rejects(tool.execute("old", { toolCallIds: ["old-branch"] }, undefined, undefined, f.ctx), /recovery is not ready/);
  const raw = await tool.execute("raw", { sourceEntryIds: [source] }, undefined, undefined, f.ctx);
  assert.match(raw.details.results[0].text, /NEW_BRANCH/);
});

for (const occ of [false, true])
  test(`effective rescan preserves raw frontier ordinals after global compaction (OCC=${occ})`, async t => {
  const f = await fixture(t, { occ });
  for (let i = 0; i < 12; i++) f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `old ${i}` }], timestamp: 100 + i });
  f.sm.appendCustomEntry("context-prune-frontier", { lastAttemptedToolCallId: "old", lastAttemptedTurnIndex: 11 });
  const kept = f.sm.appendMessage({ role: "user", content: "new effective task", timestamp: 200 });
  f.sm.appendCompaction("old summary", kept, 1000);
  f.sm.appendCustomEntry("metis-occ-state", { phase: "hold", work: 10, atWork: 0, atChars: 0 });
  f.add("FRESH_BODY ".repeat(1800), "custom inspection", "fresh");
  await f.emit("session_start");
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(f.calls[0]), /FRESH_BODY/);
  const frontier = f.sm.getBranch().filter(e => e.type === "custom" && e.customType === "context-prune-frontier").at(-1).data;
  assert.equal(frontier.lastAttemptedToolCallId, "fresh");
  assert.equal(frontier.lastAttemptedTurnIndex, 12);
});

test("a local rewrite holds through two steps and only releases after real reuse plus new history", async t => {
  const f = await fixture(t, { occ: true });
  // Exercise hold release below OCC's economic range, independently of prices.
  f.ctx.getContextUsage = () => ({ tokens: 75000, contextWindow: 100000 });
  f.add("FIRST_EVIDENCE ".repeat(1400), "custom inspection");
  await f.finish();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 4; i++) {
    // Each text group must independently fit the real tokenizer summary budget.
    const next = f.add(`NEW_${i} ` + "observation ".repeat(4000), "custom inspection");
    await f.emit("turn_end", { message: next.assistant, toolResults: [next.result], turnIndex: i });
    await f.finish();
    if (i < 3) assert.equal(f.calls.length, 1, "new text groups do not bypass the hold");
    else assert.ok(f.calls.length > 1, "real reuse and growth release eligible closed text groups");
  }
  for (let i = 0; i < 4; i++) assert.match(JSON.stringify(f.calls.slice(1)), new RegExp(`NEW_${i}`));
});


test("capacity waiting imports temporary output archives without pruning their visible results", async t => {
  const f = await fixture(t, { occ: true, capacity: true });
  f.ctx.getContextUsage = () => ({ tokens: 100001, contextWindow: 100000 });
  const temporary = join(f.dir, "temporary-native-output.log");
  writeFileSync(temporary, "ARCHIVED RAW OUTPUT");
  const call = f.add("VISIBLE RESULT TAIL", "unrecognized-command", "capacity-archive");
  call.result.details = { fullOutputPath: temporary };
  await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  rmSync(temporary);
  const recovered = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id] }, undefined, undefined, f.ctx);
  assert.equal(recovered.details.results[0].text, "ARCHIVED RAW OUTPUT");
  await f.finish(false);
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "metis-occ-state").data.capacityWaiting, true);
  const messages = projectBranchMessages(f.sm.getBranch());
  const projected = (await f.emit("context", { messages }))?.messages ?? messages;
  assert.match(JSON.stringify(projected), /VISIBLE RESULT TAIL/);
  let reads = 0;
  for (const name of ["buildSessionProjection", "buildSessionProjectionAsync"]) {
    const native = f.sm[name].bind(f.sm);
    t.mock.method(f.sm, name, (...args) => { reads++; return native(...args); });
  }
  await f.emit("agent_settled"); await f.waitMaintenance();
  assert.equal(reads, 0, "no published shared view and no admitted new work require no maintenance source read");
  assert.equal(f.calls.length, 0);
});


test("deterministic packing retains the test tail; semantic serialization preserves conditions and bounds arguments", async (t) => {
  const f = await fixture(t);
  const tail = "FINAL_TEST_RESULT_SENTINEL: all checks completed";
  const text = Array.from({ length: 260 }, (_, i) => `${i % 12 === 0 ? "warning" : "progress"} ${i}: ${"界".repeat(150)}`).join("\n") + "\n" + tail;
  f.add(text);
  await f.finish();
  assert.equal(f.calls.length, 0, "a profitable deterministic candidate does not need a paid summary");
  const packed = f.sm.getBranch().find(entry => entry.details?.representation === "packed");
  assert.ok(packed.content.includes(tail));
  const batch = { turnIndex: 0, timestamp: 1, assistantText: "plan ".repeat(5000), toolCalls: [{
    toolCallId: "large-write", toolName: "write", args: { path: "large.ts", content: "🙂".repeat(50000) },
    resultText: "log ".repeat(20000) + "FAILURE_AT_END", isError: true,
  }] };
  const input = serializeBatchForSummarizer(batch);
  assert.ok(input.length <= 65536);
  assert.match(input, /large\.ts/);
  assert.match(input, /FAILURE_AT_END/);
  assert.match(input, /Original text omitted/);
  assert.equal(input.isWellFormed(), true);
  assert.equal(serializeBatchForSummarizer({ ...batch, toolCalls: Array(1000).fill(batch.toolCalls[0]) }), undefined);
  const command = "# context\n".repeat(400) + "assert satisfies('1.0.0', '>*') is False\nprint('>=*: False')\n" + "# tail\n".repeat(400);
  const exact = serializeBatchForSummarizer({ ...batch, assistantText: "", toolCalls: [
    { ...batch.toolCalls[0], args: { command }, resultText: ">=*: False", isError: false },
  ] });
  assert.ok(exact.includes(JSON.stringify({ command }, null, 2)), "the summary sees the actual condition, not just a misleading printed label");
});

test("subagent control receipts remain verbatim while ordinary results are summarized", async t => {
  const f = await fixture(t);
  const control = { role: "toolResult", toolCallId: "control", toolName: "subagents_wait_agent", timestamp: 3,
    content: [{ type: "text", text: '{"state":"completed","exact":"' + "x".repeat(6000) + '"}' }], isError: false };
  f.sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "control", name: "subagents_wait_agent",
    arguments: { run_ids: ["completed-run"] } }], timestamp: 2, stopReason: "toolUse" });
  f.sm.appendMessage(control);
  f.add("ordinary output\n".repeat(1800), "cat ordinary.txt", "ordinary");
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert(!JSON.stringify(f.calls[0]).includes("completed-run"));
  const messages = projectBranchMessages(f.sm.getBranch());
  const projected = (await f.emit("context", { messages }))?.messages ?? messages;
  assert.deepEqual(
    projected.find((m) => m.role === "toolResult" && m.toolCallId === "control"),
    control,
  );
});

test("automatic and manual chunks keep durable progress through a failure inside one assistant turn", async (t) => {
  for (const path of ["automatic", "manual"])
    await t.test(path, async (t) => {
      let fail = true, failedInput;
      const f = await fixture(t, {
        stopReason: (n, context) => {
          const input = context.messages[0].content[0].text;
          if (fail && n === 2) failedInput = input;
          return fail && input === failedInput ? "error" : "stop";
        },
        protectedPaths: ["keep.txt"],
        chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: false },
      });
      const ids = Array.from({ length: 130 }, (_, i) => `large-chain-${i}`);
      f.sm.appendMessage({
        role: "assistant",
        timestamp: 2,
        stopReason: "toolUse",
        content: ids.map((id, i) => ({
          type: "toolCall",
          id,
          name: "bash",
          arguments: { command: `cat evidence-${i}.txt` },
        })),
      });
      for (const [i, id] of ids.entries())
        f.sm.appendMessage({
          role: "toolResult",
          toolCallId: id,
          toolName: "bash",
          content: [{ type: "text", text: `evidence-${i}\n` + "x".repeat(6000) }],
          isError: false,
          timestamp: 3 + i,
        });
      f.sm.appendMessage({ role: "user", content: "A separate task", timestamp: 200 });
      f.add("later task output\n".repeat(1400), "cat later.txt", "later-task");
      const flush = () => (path === "automatic" ? f.finish() : f.commands.get("pruner").handler("now", f.ctx));
      const summaries = () => f.sm.getBranch().filter((e) => e.customType === "context-prune-summary");
      await flush();
      const attempted = f.calls.length;
      const chunks = new Set(f.calls.map(context => context.messages[0].content[0].text));
      assert(chunks.size >= 2 && chunks.size <= 3, "failure stops beyond three chunks, even when one chunk tries fallback routes");
      assert.equal(summaries().length, 1, "first chunk persists before the second fails");
      assert.equal(
        f.sm.getBranch().filter((e) => e.customType === "context-prune-chain").length,
        0,
        "a partial flush cannot trigger automatic chain compression",
      );
      const metric = f.sm.getBranch().findLast((e) => e.customType === "context-prune-flush-metrics").data;
      assert.equal(metric.outcome, "partial");
      assert.equal(metric.processedBatches, 1);
      const refs = summaries()[0].details.toolCallRefs;
      assert(refs.length <= 24, "a long task uses bounded per-request work for the parallel window");
      const frontier = f.sm.getBranch().findLast((e) => e.customType === "context-prune-frontier").data;
      assert.equal(frontier.lastAttemptedTurnIndex, 0, "frontier stays inside the original assistant turn");
      assert.equal(frontier.attemptedToolCallCount, refs.length);
      const recall = await f.tools
        .get("context_tree_query")
        .execute("q", { toolCallIds: [refs[0].shortId] }, undefined, undefined, f.ctx);
      assert.equal(recall.details.results[0].text, "evidence-0\n" + "x".repeat(6000));
      fail = false;
      await f.emit("session_start");
      await flush();
      if (path === "automatic") {
        assert.equal(f.calls.length, attempted, "reload alone cannot fund a second rewrite");
        const work = f.add("new evidence\n".repeat(4500), "cat keep.txt");
        await f.emit("turn_end", { message: work.assistant, toolResults: [work.result], turnIndex: 1 });
        const raw = f.sm.buildSessionProjection().messages;
        const sent = (await f.emit("context", { messages: raw }))?.messages ?? raw;
        await f.finish(true, { ...usage, input: sent.reduce((sum, message) => sum + estimateTokens(message), 0) });
      }
      assert.equal(
        summaries().flatMap((e) => e.details.toolCallRefs).length,
        ids.length + 1,
        "after reload, manual or repaid automatic work resumes all remaining occurrences",
      );
      assert(
        f.calls.slice(attempted).every((call) => !JSON.stringify(call).includes('"cat evidence-0.txt"')),
        "durable first chunk is never requested again",
      );
      const count = f.calls.length;
      await flush();
      assert.equal(f.calls.length, count, "completed history stays settled");
      if (path === "manual")
        assert(f.notices.some(([message]) => /batches completed; remaining retained/.test(message)));
    });
});

test("summary requests reserve output space and local budget failures never request a provider", async (t) => {
  const f = await fixture(t);
  f.ctx.model.contextWindow = 6000;
  f.ctx.model.maxTokens = 2000;
  Object.assign(f.ctx.modelRegistry.find(), { contextWindow: 6000, maxTokens: 2000 });
  for (let i = 0; i < 3; i++) {
    const { assistant } = f.add(`结果-${i}\n` + "证据".repeat(3000), `cat unicode-${i}.txt`);
    assistant.content.unshift({ type: "text", text: "历史描述 ".repeat(2000) });
  }
  await f.finish();
  assert.equal(f.calls.length, 3, "small model automatically gets smaller chunks");
  for (const [i, call] of f.calls.entries()) {
    assert(Buffer.byteLength(call.messages[0].content[0].text, "utf8") + f.requests[i].maxTokens < 6000);
  }
  f.ctx.model.contextWindow = 2048;
  f.add("raw result\n".repeat(1800), "cat pending.txt");
  await f.finish();
  assert.equal(f.calls.length, 3);
  const metric = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
  assert.equal(metric.reason, "input-budget");
  assert.match(metric.error, /Input budget/);
  f.ctx.model.contextWindow = 6000;
  await f.finish();
  assert.equal(f.calls.length, 4, "local budget rejection retains evidence for later retry");
});

test("parallel summaries commit in order within a three-record window and reject changed sources", async (t) => {
  for (const change of ["none", "append", "content", "details"])
    await t.test(change === "none" ? "out of order" : `source changed (${change})`, async (t) => {
      const changed = change !== "none";
      const f = await fixture(t, { defer: true, mode: "tui", showPruneStatusLine: true });
      for (let i = 0; i < 5; i++) {
        f.sm.appendMessage({ role: "user", content: `Task ${i}`, timestamp: 100 + i });
        f.add(`source-${i}\n` + "界".repeat(6000), `cat source-${i}.txt`, `parallel-${i}`);
      }
      const pending = f.finish();
      await waitForSummarizer(f, 3);
      assert.equal(f.calls.length, 3, "requests overlap before any provider is released");
      assert.match(f.statuses.get("context-prune"), /\nSummarizing 1\/5/, "stale-source cases start with visible progress");
      f.release(2);
      f.release(1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.calls.length, 3, "completed later requests do not create an unbounded backlog");
      assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-summary").length, 0);
      if (change === "append") f.sm.appendMessage({ role: "user", content: "New source", timestamp: 300 });
      else if (changed) {
        const leaf = f.sm.getLeafId();
        const source = f.sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult").message;
        if (change === "content") source.content[0].text = "Evidence corrected while the summary was pending";
        else source.details = { corrected: true };
        assert.equal(f.sm.getLeafId(), leaf, "in-place changes do not bump the session leaf");
      }
      f.release(0);
      let done = false;
      pending.then(() => { done = true; }, () => { done = true; });
      for (let i = 0; i < 600 && !done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        f.releaseAll();
      }
      await pending;
      const summaries = f.sm.getBranch().filter((e) => e.customType === "context-prune-summary");
      assert.deepEqual(
        summaries.map((e) => e.details.toolCallRefs[0].toolCallId),
        changed ? [] : Array.from({ length: 5 }, (_, i) => `parallel-${i}`),
      );
      if (changed) {
        assert.equal(f.calls.length, 3);
        assert(f.requests.every((r) => r.signal.aborted));
        assert.equal(
          f.sm.getBranch().findLast((e) => e.customType === "context-prune-flush-metrics").data.reason,
          "stale-context",
        );
        const status = f.statuses.get("context-prune");
        assert.doesNotMatch(status, /Summarizing/, "stopped work must not retain in-flight progress");
        assert.match(status, /raw evidence retained/i);
        await f.emit("agent_end");
        assert.equal(f.statuses.get("context-prune"), status, "agent_end preserves the stopped-work explanation");
        const retry = f.commands.get("pruner").handler("now", f.ctx);
        let retried = false;
        retry.then(() => { retried = true; }, () => { retried = true; });
        for (let i = 0; i < 600 && !retried; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
          f.releaseAll();
        }
        assert.ok(retried, "restored queue finishes on retry");
        await retry;
        assert.ok(f.calls.length > 3, "restored work retries after a same-lifecycle source change");
      } else assert.equal(f.calls.length, 5);
    });
});

test("unchanged budget gaps retain evidence without scaling whole-context reads with the pending queue", async t => {
  const reads = [];
  for (const count of [2, 12]) await t.test(`${count} deferred/trivial pairs`, async t => {
    const f = await fixture(t, { mode: "tui", batchingMode: "turn" });
    for (let i = 0; i < count; i++) {
      f.add("x".repeat(6000), "opaque", `budget-${i}`);
      f.add(`retained tail ${i}`, "opaque", `small-${i}`);
    }
    let projections = 0;
    for (const method of ["buildSessionProjection", "buildSessionProjectionAsync"]) {
      const original = f.sm[method];
      t.mock.method(f.sm, method, function (...args) {
        projections++;
        return original.apply(this, args);
      });
    }
    await f.finish(false);
    const original = f.sm.buildSessionProjection().messages;
    const samples = [];
    for (let retry = 0; retry < 2; retry++) {
      projections = 0;
      const result = await f.emit("context", { messages: original });
      samples.push(projections);
      assert.deepEqual(result?.messages ?? original, original, "no-gain retries cannot hide or change evidence");
      const metric = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data;
      assert.equal(metric.capturedBatches, count * 2);
      assert.equal(metric.processedBatches, count);
      assert.deepEqual(metric.deferredReasons, { budget: count });
    }
    assert.equal(f.calls.length, 0, "unprofitable work cannot request a provider");
    assert.ok(!f.sm.getBranch().some(entry => entry.customType === "context-prune-frontier"
      || entry.customType === "context-prune-summary"), "later trivial batches cannot cross the budget gap");
    reads.push(Math.max(...samples));
  });
  assert.ok(reads[1] <= reads[0] + 2,
    `unchanged no-gain work must share its source view, not re-read it per batch: ${reads}`);
});

test("dedup staging rejects an earlier source mutation while archiving a later occurrence", async t => {
  const f = await fixture(t, { mode: "tui" });
  const body = "DURABLE evidence ".repeat(1000);
  f.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: "known", toolName: "bash",
    args: { command: "opaque" }, resultText: body, isError: false, turnIndex: 0, timestamp: 3, resultTimestamp: 3 }] });
  await f.emit("session_start");
  const first = f.add(body, "opaque", "duplicate-first");
  f.add(body, "opaque", "duplicate-second");
  const append = f.sm.appendCustomEntry.bind(f.sm);
  let mutated = false;
  t.mock.method(f.sm, "appendCustomEntry", (type, data) => {
    const id = append(type, data);
    if (type === "context-prune-index" && data.backfilled
      && data.toolCalls.some(call => call.toolCallId === "duplicate-second")) {
      const leaf = f.sm.getLeafId();
      const entry = f.sm.getBranch().find(entry => entry.message?.toolCallId === first.id);
      entry.message.content[0].text = "Corrected while duplicate staging was pending";
      assert.equal(f.sm.getLeafId(), leaf, "body mutation cannot be detected by a leaf-only guard");
      mutated = true;
    }
    return id;
  });
  await f.finish();
  assert.equal(mutated, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data.reason, "stale-context");
  assert.ok(!f.sm.getBranch().some(entry => entry.customType === "context-prune-frontier"));
  const request = { sessionId: f.sm.getSessionId(), messages: f.sm.buildSessionProjection().messages };
  f.events.emit(METIS_EVENTS.condenseProject, request);
  assert.equal(request.messages.find(message => message.toolCallId === first.id).content[0].text,
    "Corrected while duplicate staging was pending");
  assert.equal(request.messages.find(message => message.toolCallId === "duplicate-second").content[0].text, body);
});

test("a non-beneficial duplicate cannot rebase the source of a later summary", async t => {
  const f = await fixture(t);
  f.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: "known-small", toolName: "bash",
    args: { command: "opaque" }, resultText: "ok", isError: false, turnIndex: 0, timestamp: 3, resultTimestamp: 3 }] });
  await f.emit("session_start");
  f.add("ok", "opaque", "non-beneficial");
  const source = f.add("界".repeat(6000), "opaque", "later-semantic");
  const corrected = "Corrected semantic evidence ".repeat(2000);
  const append = f.sm.appendCustomEntry.bind(f.sm);
  let mutated = false;
  t.mock.method(f.sm, "appendCustomEntry", (type, data) => {
    const id = append(type, data);
    if (!mutated && type === "context-prune-index" && data.backfilled
      && data.toolCalls.some(call => call.toolCallId === "non-beneficial")) {
      const leaf = f.sm.getLeafId();
      f.sm.getBranch().find(entry => entry.message?.toolCallId === source.id).message.content[0].text = corrected;
      assert.equal(f.sm.getLeafId(), leaf);
      mutated = true;
    }
    return id;
  });
  await f.finish(false);
  assert.equal(mutated, true);
  assert.equal(f.calls.length, 0, "the old candidate cannot request a summary against a rebased source");
  assert.ok(!f.sm.getBranch().some(entry => entry.customType === "context-prune-frontier"
    || entry.customType === "context-prune-summary"));
  assert.equal(f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data.reason, "stale-context");
  assert.equal(f.sm.buildSessionProjection().messages.find(message => message.toolCallId === source.id).content[0].text, corrected);
});

test("TUI flush yields to queued input and rechecks source freshness before publishing", async t => {
  const f = await fixture(t);
  f.ctx.mode = "tui";
  for (let i = 0; i < 5; i++) f.add("Short evidence", "inspect", `yield-${i}`);
  let clock = 0;
  t.mock.method(performance, "now", () => clock += 20);
  let inputHandled = false;
  const input = new Promise(resolve => setImmediate(() => {
    inputHandled = true;
    f.sm.appendMessage({ role: "user", content: "Queued input", timestamp: f.nextTimestamp() });
    resolve();
  }));
  await f.finish(false);
  const handledDuringFlush = inputHandled;
  await input;
  assert.equal(handledDuringFlush, true, "a flush slice lets the event loop handle queued input");
  assert.equal(f.calls.length, 0);
  assert.ok(!f.sm.getBranch().some(entry => entry.customType === "context-prune-frontier"));
  assert.equal(f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data.reason,
    "stale-context", "yielding must not authorize work from the old source");
});

test(
  "a tree switch cancels concurrent requests, preserves the durable prefix and restores the suffix",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, { defer: true });
    for (let i = 0; i < 100; i++) f.add(`source-${i}\n` + (i >= 96 ? "界" : "x").repeat(6000), `cat source-${i}.txt`);
    const waitForCalls = async (count) => {
      for (let i = 0; i < 1000 && f.calls.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(f.calls.length, count);
    };
    const first = f.finish();
    await waitForCalls(3);
    f.release(0);
    for (let i = 0; i < 300 && !f.sm.getBranch().some((e) => e.customType === "context-prune-summary"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const attempted = f.calls.length;
    assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-summary").length, 1);
    await f.emit("session_tree");
    await first;
    assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-summary").length, 1);
    assert.equal(f.calls.length, attempted, "old lifecycle starts no later requests");
    assert(
      f.requests.slice(0, attempted).every((r) => r.signal.aborted),
      "cancel propagates to every old provider request",
    );
    const resumed = f.finish();
    // Release each newly scheduled mock request until the actual flush settles,
    // rather than imposing a three-second throughput target on a large fixture.
    const releasing = setInterval(() => f.releaseAll(), 5);
    try {
      await resumed;
    } finally {
      clearInterval(releasing);
    }
    assert(f.calls.slice(attempted).every((call) => !JSON.stringify(call).includes('"cat source-0.txt"')));
    assert.equal(
      f.sm.getBranch().findLast((e) => e.customType === "context-prune-flush-metrics").data.outcome,
      "summarized",
    );
  },
);

test("closed large write arguments become stable historical records with exact recall and edit recovery", async (t) => {
  const f = await fixture(t, { mode: "tui" });
  const args = { path: "large.ts", content: "ORIGINAL_CODE\n".repeat(3000) };
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "large-write", name: "write", arguments: args }],
    stopReason: "toolUse",
    timestamp: 2,
  };
  const sourceId = f.sm.appendMessage(assistant);
  f.sm.appendMessage({
    role: "toolResult",
    toolCallId: "large-write",
    toolName: "write",
    isError: false,
    content: [{ type: "text", text: "Successfully wrote file" }],
    timestamp: 3,
  });
  f.add("Recent evidence stays inline", "echo recent");
  await f.finish();
  assert.equal(f.calls.length, 0);
  const original = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: original })).messages;
  assert.ok(JSON.stringify(projected).length < JSON.stringify(original).length / 2);
  assert.ok(!projected.some((m) => m.role === "toolResult" && m.toolCallId === "large-write"));
  assert.ok(
    !projected.some(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === "large-write"),
    ),
  );
  assert.match(JSON.stringify(projected), /component=arguments/);
  assert.equal(f.notices.length, 1, "argument-only work gets one confirmed action notice, not a trivial-skip notice");
  assert.match(f.notices[0][0], /pruned 1 argument group/);
  const tool = f.tools.get("context_tree_query");
  let page = (
    await tool.execute("q", { toolCallIds: ["large-write@3"], component: "arguments" }, undefined, undefined, f.ctx)
  ).details;
  let restored = page.results[0].text;
  while (page.nextCursor) {
    page = (
      await tool.execute(
        "q",
        { toolCallIds: ["large-write@3"], component: "arguments", cursor: page.nextCursor },
        undefined,
        undefined,
        f.ctx,
      )
    ).details;
    restored += page.results[0].text;
  }
  assert.deepEqual(JSON.parse(restored), args);
  await f.emit("session_start");
  assert.deepEqual((await f.emit("context", { messages: original })).messages, projected);
  f.sm.appendContextEdit(sourceId, {
    content: [{ ...assistant.content[0], arguments: { path: "large.ts", content: "CORRECTED" } }],
  });
  const effective = f.sm.buildSessionProjection().messages;
  const afterEdit = (await f.emit("context", { messages: effective }))?.messages ?? effective;
  assert.ok(afterEdit.some((m) => m.role === "toolResult" && m.toolCallId === "large-write"));
  assert.match(JSON.stringify(afterEdit), /CORRECTED/);
});

test("screening already stubbed write groups after recovery does not read their archive bodies", async (t) => {
  const f = await fixture(t, { mode: "tui" });
  const args = { path: "large.ts", content: "ORIGINAL_CODE\n".repeat(600) };
  const assistant = {
    role: "assistant", api: f.ctx.model.api, provider: f.ctx.model.provider, model: f.ctx.model.id,
    content: [{ type: "toolCall", id: "archived-write", name: "write", arguments: args }],
    stopReason: "toolUse", timestamp: f.nextTimestamp(),
  };
  f.sm.appendMessage(assistant);
  const resultTimestamp = f.nextTimestamp(), resultText = "Successfully wrote file";
  f.sm.appendMessage({
    role: "toolResult", toolCallId: "archived-write", toolName: "write", isError: false,
    content: [{ type: "text", text: resultText }], timestamp: resultTimestamp,
  });
  const archiveId = f.sm.appendCustomEntry("context-prune-index", { toolCalls: [{
    toolCallId: "archived-write", toolName: "write", args, resultText, resultTimestamp,
    isError: false, turnIndex: 0, timestamp: assistant.timestamp,
  }] });
  f.add("Recent evidence stays inline", "echo recent");
  await f.emit("session_start");

  const getEntry = f.sm.getEntryForScan.bind(f.sm);
  let archiveReads = 0;
  t.mock.method(f.sm, "getEntryForScan", (id) => {
    if (id === archiveId) archiveReads++;
    return getEntry(id);
  });
  const projected = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
  const stub = projected.find((message) => message.toolCallId === "archived-write");
  assert.match(stub.content[0].text, /recover|retrieve/i);
  assert.notEqual(stub.content[0].text, resultText);
  archiveReads = 0;
  await f.finish(false);
  await f.finish(false);
  assert.equal(f.sm.getBranchMetadata().filter((entry) => entry.customType === "context-prune-arguments").length, 0);
  assert.equal(archiveReads, 0, "screening a rejected rewrite must not decode the archived body");

  const query = f.tools.get("context_tree_query");
  const recall = await query.execute("exact", {
    toolCallIds: [`archived-write@${resultTimestamp}`], component: "arguments",
  }, undefined, undefined, f.ctx);
  assert.deepEqual(JSON.parse(recall.details.results[0].text), args);
  assert.ok(archiveReads > 0, "explicit recall still reads the archived arguments");
});

for (const kind of ["failed", "protected", "mixed", "recent", "fusion-failed"]) {
  test(`argument compaction keeps ${kind} tool groups verbatim`, async (t) => {
    const f = await fixture(t);
    const args = { path: kind === "protected" ? "skills/rule.md" : "large.ts", content: "code ".repeat(6000) };
    const content = [{ type: "toolCall", id: "write-guard", name: "write", arguments: args }];
    if (kind === "mixed")
      content.push({ type: "toolCall", id: "other", name: "read", arguments: { path: "other.txt" } });
    f.sm.appendMessage({ role: "assistant", content, stopReason: "toolUse", timestamp: 2 });
    f.sm.appendMessage({
      role: "toolResult",
      toolCallId: "write-guard",
      toolName: "write",
      timestamp: 3,
      isError: kind === "failed",
      content: [
        { type: "text", text: "mutation result" },
        { type: "text", text: "command failed" },
      ],
      ...(kind === "fusion-failed"
        ? {
            details: {
              metisActionFusion: {
                version: 1,
                mutationStatus: "success",
                command: { command: "npm test", status: "failed", exitCode: 1, outputBlock: 1 },
              },
            },
          }
        : {}),
    });
    if (kind === "mixed")
      f.sm.appendMessage({
        role: "toolResult",
        toolCallId: "other",
        toolName: "read",
        content: [{ type: "text", text: "other evidence" }],
        isError: false,
        timestamp: 4,
      });
    if (kind !== "recent") f.add("newest evidence", "echo newest");
    await f.finish();
    assert.equal(f.sm.getBranch().filter((e) => e.customType === "context-prune-arguments").length, 0);
    const original = f.sm.buildSessionProjection().messages;
    const rendered = (await f.emit("context", { messages: original }))?.messages ?? original;
    const write = rendered.find((m) => m.role === "assistant" && m.content.some((b) => b.id === "write-guard"));
    assert.deepEqual(write.content[0].arguments, args);
  });
}

test("shared chains preserve every endpoint, recover the block and stop deriving from an edited member", async (t) => {
  const f = await fixture(t, {
    pruneOn: "on-demand",
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true },
  });
  for (let i = 0; i < 2; i++) {
    f.sm.appendMessage({ role: "user", content: `shared-request-${i}`, timestamp: f.nextTimestamp() });
    f.add(`raw-shared-${i}`, `echo member-${i}`, `member-${i}`, "Independent intermediate reasoning. ".repeat(100));
    f.sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `shared-final-${i}` }],
      stopReason: "stop",
      timestamp: f.nextTimestamp(),
    });
  }
  await f.emit("agent_settled");
  await f.waitMaintenance();
  const block = f.sm.getBranch().find((e) => e.customType === "context-prune-chain").data;
  const raw = () => f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw() })).messages;
  assert.equal(f.calls.length, 0);
  assert.equal(projected.filter((m) => m.metisDerived?.kind === "condense-chain").length, 1);
  const settingsPath = join(f.dir, "metis-pi.toml");
  const settings = parseMetisConfig(readFileSync(settingsPath, "utf8"));
  settings.contextPrune.chainCompression.enabled = false;
  writeFileSync(settingsPath, stringify(settings));
  await f.emit("session_start");
  await f.emit("agent_settled"); await f.waitMaintenance();
  assert.deepEqual((await f.emit("context", { messages: raw() })).messages, projected,
    "committed shared ranges are revalidated on reload even with automatic scheduling disabled");
  assert.equal(f.calls.length, 0);
  for (let i = 0; i < 2; i++) {
    assert.ok(projected.some(m => m.content === `shared-request-${i}`));
    assert.ok(projected.some(m => m.role === "assistant" && m.content.some(b => b.text === `shared-final-${i}`)));
  }
  const page = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [block.blockId] }, undefined, undefined, f.ctx);
  assert.deepEqual(page.details.results.map(result => result.text), ["raw-shared-0", "raw-shared-1"]);
  const source = f.sm.getBranch().find(e => e.type === "message" && e.message.toolCallId === "member-0");
  f.sm.appendContextEdit(source.id, { content: [{ type: "text", text: "CORRECTED_SHARED_EVIDENCE" }] });
  const changed = (await f.emit("context", { messages: raw() }))?.messages ?? raw();
  assert.match(JSON.stringify(changed), /CORRECTED_SHARED_EVIDENCE/);
  await f.emit("agent_settled"); await f.waitMaintenance();
  const partial = (await f.emit("context", { messages: raw() })).messages;
  assert.match(JSON.stringify(partial), /CORRECTED_SHARED_EVIDENCE/);
  const body = partial.find(m => m.metisDerived?.kind === "condense-chain").content[0].text;
  assert.doesNotMatch(body, /member-0/);
  assert.match(body, /member-1/);
  await f.emit("session_start");
  assert.deepEqual((await f.emit("context", { messages: raw() })).messages, partial);
});

test("Native completion drops the stale queue while retaining pending work in its new window", async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", showPruneStatusLine: true,
    autoBudgetThreshold: null, budgetTurnDelta: 0, frontierGapThresholdTokens: 0 });
  const start = f.sm.appendMessage({ role: "user", content: "old task", timestamp: 1000 });
  const call = f.add("pending evidence ".repeat(500), "unknown-command", "queued");
  await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  assert.match(f.statuses.get("context-prune"), /\n1 turn queued/);
  const event = { signal: new AbortController().signal, reason: "manual", willRetry: false,
    branchEntries: f.sm.getBranch(), preparation: { firstKeptEntryId: start, tokensBefore: 10000 } };
  await f.emit("session_before_compact", event);
  await f.emit("session_compact_failed", { reason: "manual", aborted: false, error: "offline" });
  assert.match(f.statuses.get("context-prune"), /\n1 turn queued/, "failure cannot discard live work");
  await f.emit("session_before_compact", { ...event, signal: new AbortController().signal });
  const next = f.sm.appendMessage({ role: "user", content: "next window", timestamp: 2000 });
  const compacted = f.sm.appendCompaction("old work compacted", next, 10000);
  await f.emit("session_compact", { compactionEntry: f.sm.getEntry(compacted), reason: "manual", willRetry: false });
  assert.match(f.statuses.get("context-prune"), /\nNo pending turns$/);
  assert.equal(f.calls.length, 0);
  const kept = f.sm.appendMessage({ role: "user", content: "surviving task", timestamp: 3000 });
  const survivor = f.add("surviving evidence ".repeat(2000), "unknown-command", "survivor");
  await f.emit("turn_end", { message: survivor.assistant, toolResults: [survivor.result], turnIndex: 1 });
  const id = f.sm.appendCompaction("only earlier work compacted", kept, 10000);
  await f.emit("session_compact", { compactionEntry: f.sm.getEntry(id), reason: "manual", willRetry: false });
  assert.match(f.statuses.get("context-prune"), /\n1 turn queued/);
  await f.commands.get("pruner").handler("now", { ...f.ctx, mode: "print", hasUI: false });
  assert.equal(f.calls.length, 1, "surviving queued work is recovered from persisted source without another tool turn");
  const final = f.sm.appendMessage({ role: "user", content: "empty window", timestamp: 4000 });
  const committed = f.sm.appendCompaction("all earlier work compacted", final, 10000);
  const read = t.mock.method(f.sm, "buildSessionProjectionAsync", async () => { throw new Error("fixture read failed"); });
  const log = t.mock.method(console, "error", () => {});
  await assert.doesNotReject(f.emit("session_compact", { compactionEntry: f.sm.getEntry(committed), reason: "manual" }));
  assert.match(f.statuses.get("context-prune"), /Pending-turn inspection unavailable$/);
  read.mock.restore(); log.mock.restore();
});

test("a flush finishing after Native compaction cannot restore the old window's queued payloads", async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", showPruneStatusLine: true, defer: true,
    autoBudgetThreshold: null, budgetTurnDelta: 0, frontierGapThresholdTokens: 0 });
  const call = f.add("semantic evidence ".repeat(2000), "unknown-command", "old-window");
  await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  const pending = f.commands.get("pruner").handler("now", { ...f.ctx, mode: "print", hasUI: false });
  await waitForSummarizer(f);
  try {
    await f.emit("session_before_compact", { signal: new AbortController().signal,
      branchEntries: f.sm.getBranch(), preparation: { tokensBefore: 10000 } });
    const kept = f.sm.appendMessage({ role: "user", content: "new task", timestamp: 1000 });
    const id = f.sm.appendCompaction("old task compacted", kept, 10000);
    await f.emit("session_compact", { compactionEntry: f.sm.getEntry(id), reason: "manual" });
    assert.equal(f.requests[0].signal.aborted, true, "Native completion cancels obsolete provider work");
  } finally { f.releaseAll(); await pending; }
  const fresh = f.add("fresh pending evidence ".repeat(500), "unknown-command", "new-window");
  await f.emit("turn_end", { message: fresh.assistant, toolResults: [fresh.result], turnIndex: 1 });
  assert.match(f.statuses.get("context-prune"), /\n1 turn queued/);
  assert.equal(f.calls.length, 1, "no new automatic model request is admitted");
  assert.equal(f.sm.getBranch().filter(entry => entry.customType === "context-prune-summary").length, 0);
});

test("Native completion, cancellation and failure preserve published views before the next request", async t => {
  for (const occ of [false, true]) for (const outcome of ["completed", "cancelled", "failed"]) {
    await t.test(`${occ ? "OCC" : "Native"} ${outcome}`, async t => {
      const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", occ, capacity: occ,
        chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
      f.ctx.getContextUsage = () => ({ tokens: 80000, contextWindow: 100000 });
      f.sm.appendCustomMessageEntry("legacy-prefix", "Legacy context", false);
      addClosedChains(f);
      await f.emit("agent_settled"); await f.waitMaintenance();
      const first = f.sm.getBranch().find(e => e.type === "message" && e.message.role === "user");
      const project = async () => {
        const messages = f.sm.buildSessionProjection().messages;
        return (await f.emit("context", { messages }))?.messages ?? messages;
      };
      const before = await project();
      assert.equal(before.filter(m => m.metisDerived?.kind === "condense-chain").length, 1);
      const controller = new AbortController();
      await f.emit("session_before_compact", { signal: controller.signal, reason: "manual", willRetry: false,
        branchEntries: f.sm.getBranch(), preparation: { firstKeptEntryId: first.id, tokensBefore: 90000 } });
      const owner = { sessionId: f.sm.getSessionId(), messages: f.sm.buildSessionProjection().messages, maintenance: true };
      f.events.emit(METIS_EVENTS.condenseProject, owner);
      assert.equal(owner.busy, undefined, "Native may read the existing view while it owns compaction");
      assert.deepEqual(owner.messages, before);
      if (outcome === "completed") {
        const id = f.sm.appendCompaction("Legacy prefix summarized", first.id, 90000);
        await f.emit("session_compact", { compactionEntry: f.sm.getEntry(id), reason: "manual", willRetry: false });
      } else if (outcome === "cancelled") controller.abort();
      else await f.emit("session_compact_failed", { reason: "manual", aborted: false, error: "offline failure" });
      const after = await project();
      assert.equal(after.filter(m => m.metisDerived?.kind === "condense-chain").length, 1,
        "published views must be ready for the first request, not only a later settlement");
      if (outcome !== "completed") assert.deepEqual(after, before, "unchanged sources retain identical views");
      assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 1);
      assert.equal(f.calls.length, 0, "revalidation must not call a summary model");
    });
  }
});

test("Native window changes validate surviving members without publishing newly eligible chains", async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand",
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  for (let generation = 0; generation < 2; generation++) {
    addClosedChains(f);
    const messages = f.sm.buildSessionProjection().messages;
    const message = messages.findLast(m => m.role === "assistant" && m.stopReason === "toolUse");
    const result = messages.findLast(m => m.role === "toolResult");
    await f.emit("turn_end", { message, toolResults: [result], turnIndex: generation });
    await f.emit("agent_settled"); await f.waitMaintenance();
  }
  const blocks = () => f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
  assert.equal(blocks().length, 2);
  const firstKept = f.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user")[1];
  addClosedChains(f); // New work is eligible, but this boundary owns only existing views.
  const controller = new AbortController();
  await f.emit("session_before_compact", { signal: controller.signal, reason: "manual", willRetry: false,
    branchEntries: f.sm.getBranch(), preparation: { firstKeptEntryId: firstKept.id, tokensBefore: 90000 } });
  const id = f.sm.appendCompaction("Old prefix summarized", firstKept.id, 90000);
  await f.emit("session_compact", { compactionEntry: f.sm.getEntry(id), reason: "manual", willRetry: false });
  const messages = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages }))?.messages ?? messages;
  const views = projected.filter(m => m.metisDerived?.kind === "condense-chain");
  assert.equal(views.length, 2, "the partial first block and complete second block remain profitable");
  assert.equal(blocks().length, 2, "readiness validation must not publish the third eligible group");
  assert.ok(projected.some(m => m.role === "toolResult"), "new uncompressed evidence remains visible");
  assert.equal(f.calls.length, 0);
});

test("Native handoff restores published shared views without admitting new chains", async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand", occ: true, capacity: true,
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  let tokens = 80000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: 100000 });
  addClosedChains(f);
  await f.emit("agent_settled"); await f.waitMaintenance();
  const blocks = () => f.sm.getBranchMetadata().filter(e => e.customType === "context-prune-chain");
  assert.equal(blocks().length, 1);
  addClosedChains(f); // Fresh eligible work must remain deferred, not piggyback on local revalidation.
  const project = () => {
    const request = { sessionId: f.sm.getSessionId(), messages: f.sm.buildSessionProjection().messages,
      api: f.ctx.model.api, maintenance: true };
    f.events.emit(METIS_EVENTS.condenseProject, request);
    return request.messages;
  };
  assert.equal(project().filter(m => m.metisDerived?.kind === "condense-chain").length, 1);
  for (const level of [89550, 100001]) {
    tokens = level;
    await f.finish(false);
    const before = project();
    const waiting = () => !!f.sm.getBranch().findLast(e => e.customType === "metis-occ-state").data.capacityWaiting;
    assert.equal(waiting(), tokens > 99500, "soft handoff must not claim hard-capacity takeover");
    for (const boundary of ["session_start", "session_tree"]) {
      await f.emit(boundary);
      await f.emit("agent_settled"); await f.waitMaintenance();
      assert.deepEqual(project(), before, "published rendering is independent of capacity admission");
      assert.equal(waiting(), tokens > 99500, "restoring a view must preserve the actual capacity state");
      assert.equal(blocks().length, 1, "Native handoff still blocks new chain publication");
    }
  }
  assert.equal(f.calls.length, 0, "existing shared validation does not request another model summary");
});

test("editing or omitting a summary restores its whole source group without changing the archive", async t => {
  for (const omitted of [false, true]) await t.test(omitted ? "omitted" : "edited", async t => {
    const f = await fixture(t, { pruneOn: "on-demand" });
    const sources = [
      f.add("first semantic evidence ".repeat(1000), "unknown-command", "summary-source-1"),
      f.add("second semantic evidence ".repeat(1000), "unknown-command", "summary-source-2"),
    ];
    await f.commands.get("pruner").handler("now", f.ctx);
    const summary = f.sm.getBranch().find(e => e.customType === "context-prune-summary");
    assert.equal(summary.details.toolCallRefs.length, sources.length);
    const before = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
    assert.ok(sources.every(source => before.find(m => m.toolCallId === source.id).content[0].text !== source.result.content[0].text),
      "the summary must authorize real stubs before the edit");
    f.sm.appendContextEdit(summary.id, omitted ? null : { content: "CORRECTED_SUMMARY_BODY" });
    const effective = f.sm.buildSessionProjection().messages;
    const after = (await f.emit("context", { messages: effective }))?.messages ?? effective;
    for (const source of sources) {
      assert.deepEqual(after.find(m => m.toolCallId === source.id).content, source.result.content);
      const recovered = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [source.id] }, undefined, undefined, f.ctx);
      assert.equal(recovered.details.results[0].text, source.result.content[0].text);
    }
    const summaries = after.filter(m => m.customType === "context-prune-summary");
    assert.deepEqual(summaries.map(m => m.content), omitted ? [] : ["CORRECTED_SUMMARY_BODY"]);
    assert.equal(f.calls.length, 1, "source edits must not start another summary request");
  });
});

test("pruner off silently aborts an active flush, records cancellation and retains raw evidence", async t => {
  const f = await fixture(t, { defer: true });
  const source = f.add("semantic source ".repeat(2000), "unknown-command", "cancelled");
  const finishing = f.finish(false);
  await waitForSummarizer(f);
  await f.commands.get("pruner").handler("off", f.ctx);
  await finishing;
  const metrics = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
  assert.equal(metrics.outcome, "aborted");
  assert.ok(!f.notices.some(([message]) => /summarization failed|summarize: aborted/.test(message)));
  assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier" || e.customType === "context-prune-summary"));
  assert.equal(f.sm.buildSessionProjection().messages.find(m => m.toolCallId === source.id).content[0].text, source.result.content[0].text);
});

test("display settings save without aborting an active summary", async t => {
  for (const field of ["showOccStatusLine", "showPruneStatusLine", "quietOversizedSkips"])
    await t.test(field, async t => {
      const f = await fixture(t, { defer: true });
      const initial = (await loadConfig())[field];
      f.add("semantic source ".repeat(2000), "unknown-command", "display-stable");
      const finishing = f.finish(false);
      await waitForSummarizer(f);
      await changeSetting(f, field);
      assert.equal((await loadConfig())[field], !initial, "the display change is still persisted");
      assert.equal(f.requests[0].signal.aborted, false, "display changes cannot invalidate provider work");
      f.releaseAll();
      await finishing;
      assert.equal(f.calls.length, 1);
      assert.ok(f.sm.getBranch().some(e => e.details?.representation === "summary"));
    });
});

test("real policy changes cancel an active summary and retain its source", async t => {
  for (const command of ["thinking low", "protected-tools bash"])
    await t.test(command, async t => {
      const f = await fixture(t, { defer: true });
      const source = f.add("semantic source ".repeat(2000), "unknown-command", "policy-changed");
      const finishing = f.finish(false);
      await waitForSummarizer(f);
      await f.commands.get("pruner").handler(command, f.ctx);
      await finishing;
      assert.equal(f.requests[0].signal.aborted, true);
      assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-summary" || e.customType === "context-prune-frontier"));
      assert.deepEqual(f.sm.buildSessionProjection().messages.find(m => m.toolCallId === source.id).content, source.result.content);
      assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.outcome, "aborted");
    });
});

test("display changes retain published chain approvals and cached measurements", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  const compare = TokenEstimator.prototype.compare;
  let comparisons = 0;
  t.mock.method(TokenEstimator.prototype, "compare", function (...args) {
    comparisons++;
    return compare.apply(this, args);
  });
  addClosedChains(f);
  await f.emit("agent_settled");
  await f.waitMaintenance();
  const raw = () => f.sm.buildSessionProjection().messages;
  const before = (await f.emit("context", { messages: raw() })).messages;
  assert.ok(before.some(m => m.metisDerived?.kind === "condense-chain"));
  const measured = comparisons;
  for (const field of ["showOccStatusLine", "showPruneStatusLine", "quietOversizedSkips"]) await changeSetting(f, field);
  assert.deepEqual((await f.emit("context", { messages: raw() })).messages, before, "display changes retain the existing authorized projection");
  await f.emit("agent_settled");
  await f.waitMaintenance();
  assert.equal(comparisons, measured, "display changes do not discard the existing gain authorization");
});

test("display changes do not cancel in-flight chain maintenance", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  const compare = TokenEstimator.prototype.compare;
  let signal, release;
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(TokenEstimator.prototype, "compare", async function (...args) {
    signal = args[2];
    await gate;
    return compare.apply(this, args);
  });
  try {
    addClosedChains(f);
    await f.emit("agent_settled");
    const deadline = Date.now() + 3000;
    while (!signal && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(signal, "maintenance must reach gain measurement before changing display settings");
    for (const field of ["showOccStatusLine", "showPruneStatusLine", "quietOversizedSkips"]) await changeSetting(f, field);
    assert.equal(signal.aborted, false);
  } finally {
    release();
    await f.waitMaintenance();
  }
  assert.ok(f.sm.getBranch().some(e => e.customType === "context-prune-chain"), "the unchanged candidate remains publishable");
  assert.equal(f.calls.length, 0);
});

test("manual progress uses the same packed/semantic runs as execution", async t => {
  const f = await fixture(t, { mode: "tui", showPruneStatusLine: true, defer: true, pruneOn: "on-demand" });
  f.add(buildLog, "npm run build", "packed-run");
  f.add("unpackable semantic evidence ".repeat(1000), "unknown-command", "semantic-run");
  const flushing = f.commands.get("pruner").handler("now", f.ctx);
  await waitForSummarizer(f);
  // Paid work is scheduled ahead of ordered commits; provider start alone
  // cannot prove that the preceding packed batch has committed.
  const packed = () => f.sm.getBranch().some(e => e.type === "custom_message" && e.details?.representation === "packed");
  const deadline = Date.now() + 3000;
  while (!packed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(packed(), "packed work must commit while the semantic provider is still pending");
  const create = f.widgets.findLast(([, value]) => typeof value === "function")[1];
  const widget = create({ requestRender() {} }, { fg: (_color, text) => text });
  const pending = widget.render(120);
  assert.equal(pending.length, 2);
  assert.match(pending[0], /^✓ Batch 1\/2/);
  assert.ok(pending[1] && !pending[1].startsWith("✓"), "semantic work cannot be marked done before the provider completes");
  f.releaseAll();
  await flushing;
  assert.ok(widget.render(120).every(row => row.startsWith("✓")));
  assert.ok(f.notices.some(([message, type]) => /pruner: pruned .*from 2 batches/.test(message) && type === "info"),
    "the explicit prune action reply remains visible in TUI mode");
  assert.ok(!f.notices.some(([message]) => /[3-9]\/2|2\/1/.test(message)));
});

test("measurement deferral respects TUI disclosure and quiet while retaining raw evidence", async t => {
  for (const mode of ["tui", "rpc"]) for (const quietOversizedSkips of [false, true])
    await t.test(`${mode}, quiet=${quietOversizedSkips}`, async t => {
      const f = await fixture(t, { mode, showPruneStatusLine: true, quietOversizedSkips, batchingMode: "agent-turn" });
      const source = f.add("semantic source ".repeat(2000), "unknown-command", "measurement-gap");
      const trivial = f.add("small", "unknown-command", "later-trivial");
      t.mock.method(TokenEstimator.prototype, "measure", async () => null);
      await f.finish();
      const metrics = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
      assert.equal(metrics.outcome, "partial");
      assert.equal(metrics.reason, "deferred");
      assert.deepEqual(metrics.deferredReasons, { measurement: 1 });
      assert.equal(metrics.error, undefined);
      const status = f.statuses.get("context-prune");
      assert.equal(status.split("\n")[0], "│ prune: ON · usage: 0 tokens");
      assert.equal(/\n.*retained pending — token measurement unavailable/.test(status), !quietOversizedSkips);
      assert.equal(/\n.*1 small batch skipped.*5 total raw chars retained/.test(status), !quietOversizedSkips,
        "disclosure summarizes small batches unless explicitly quieted");
      assert.equal(f.notices.some(([message]) => /retained pending/.test(message)), mode !== "tui" && !quietOversizedSkips);
      assert.equal(f.notices.some(([message]) => /skipped pruning turn/.test(message)), mode !== "tui" && !quietOversizedSkips);
      assert.ok(!f.notices.some(([message]) => /pressure\/budget|summarization failed/.test(message)));
      if (mode === "tui") assert.deepEqual(f.notices, [], "trivial bookkeeping behind a pending gap is not a rewrite");
      await f.emit("agent_end");
      assert.equal(f.statuses.get("context-prune"), status, "pending work cannot replace the detailed skip reasons");
      assert.equal(f.calls.length, 0);
      assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier"));
      assert.equal(f.sm.buildSessionProjection().messages.find(m => m.toolCallId === source.id).content[0].text, source.result.content[0].text);
      assert.equal(f.sm.buildSessionProjection().messages.find(m => m.toolCallId === trivial.id).content[0].text, "small");
    });
});

test("automatic-disabled deferral is distinct from pressure and keeps packing below the gap", async t => {
  const f = await fixture(t, { mode: "tui", showPruneStatusLine: true, quietOversizedSkips: false, autoBudgetThreshold: null });
  f.add("semantic source ".repeat(2000), "unknown-command", "automatic-gap");
  f.add(buildLog, "npm run build", "later-packed");
  await f.finish();
  const metrics = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
  assert.equal(metrics.outcome, "partial");
  assert.equal(metrics.reason, "deferred");
  assert.deepEqual(metrics.deferredReasons, { "automatic-disabled": 1 });
  assert.equal(metrics.error, undefined);
  assert.equal(f.calls.length, 0);
  assert.ok(f.sm.getBranch().some(e => e.details?.representation === "packed"));
  assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier"));
  assert.equal(f.notices.length, 1, "a partial flush announces only committed packing, not its deferred gap");
  assert.match(f.notices[0][0], /pruner: pruned 1 tool batch/);
  assert.match(f.statuses.get("context-prune"), /\n.*retained pending — automatic summarization disabled/);
});

test("an unavailable post-summary measurement retains evidence without calling it inadequate budget", async t => {
  const f = await fixture(t);
  const measure = TokenEstimator.prototype.measure;
  t.mock.method(TokenEstimator.prototype, "measure", async function (before, after) {
    if (before[0]?.customType === "context-prune-summary" && /Finished/.test(before[0].content)) return null;
    return measure.call(this, before, after);
  });
  f.add("semantic source ".repeat(2000), "unknown-command", "post-summary-measurement");
  await f.finish();
  assert.equal(f.calls.length, 1);
  const metrics = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
  assert.equal(metrics.reason, "deferred");
  assert.deepEqual(metrics.deferredReasons, { measurement: 1 });
  assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier" || e.customType === "context-prune-summary"));
});

test("manual capture errors report retained pending work and the unchanged work can retry", async t => {
  const f = await fixture(t, { mode: "tui", pruneOn: "on-demand" });
  f.add("semantic source ".repeat(2000), "unknown-command", "scan-pending");
  const getBranch = f.sm.getBranch.bind(f.sm);
  const mock = t.mock.method(f.sm, "getBranchMetadata", () => { throw new Error("offline branch read failed"); });
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.ok(f.notices.some(([message]) => /could not inspect pending batches.*raw results retained/.test(message)));
  assert.ok(!f.notices.some(([message]) => /nothing pending/.test(message)));
  assert.equal(f.calls.length, 0);
  mock.mock.restore();
  assert.ok(getBranch().some(e => e.message?.toolCallId === "scan-pending"));
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.equal(f.calls.length, 1);
  assert.ok(f.sm.getBranch().some(e => e.customType === "context-prune-summary"));
});

test("trivial aggregate sizes are retention totals, not a comparison against one batch gate", async t => {
  const f = await fixture(t, {
    mode: "tui", showPruneStatusLine: true, quietOversizedSkips: false, pruneOn: "on-demand", batchingMode: "agent-turn",
  });
  f.add("x".repeat(3200), "unknown-command", "small-one");
  f.add("y".repeat(3300), "unknown-command", "small-two");
  await f.commands.get("pruner").handler("now", f.ctx);
  assert.equal(f.calls.length, 0);
  assert.ok(f.notices.some(([message]) => /6500 total raw chars retained; summary candidates below minBatchChars=5000/.test(message)));
  assert.ok(!f.notices.some(([message]) => /6500 raw chars below/.test(message)));
  assert.ok(!f.notices.some(([message]) => /skipped pruning turn/.test(message)), "routine skips stay out of TUI chat");
  const status = f.statuses.get("context-prune");
  assert.match(status, /\n.*2 small batches skipped.*6500 total raw chars retained/);
  assert.equal(status.split("\n").length, 3, "the footer keeps one aggregate rather than a notice per batch");
  assert.doesNotMatch(status, /skipped pruning turn/);
  await f.emit("agent_end");
  assert.equal(f.statuses.get("context-prune"), status, "task completion retains only the compact current result");
  await changeSetting(f, "showPruneStatusLine");
  assert.equal(f.statuses.get("context-prune"), undefined);
  await changeSetting(f, "showPruneStatusLine");
  assert.equal(f.statuses.get("context-prune"), status, "hiding status does not destroy runtime detail");
});

test("dedup totals exclude unrelated trivial results", async t => {
  const f = await fixture(t, { mode: "tui", quietOversizedSkips: false, pruneOn: "on-demand", batchingMode: "agent-turn" });
  const body = "semantic evidence ".repeat(1500);
  f.add(body, "unknown-command", "original-dedup");
  await f.commands.get("pruner").handler("now", f.ctx);
  f.notices.length = 0;
  f.add(body, "unknown-command", "copy-dedup");
  f.add("small", "another-unknown-command", "small-not-dedup");
  await f.commands.get("pruner").handler("now", f.ctx);
  const notice = f.notices.findLast(([message]) => /deduplicated 1 tool call/.test(message))[0];
  assert.ok(notice.includes(`(${body.length} raw chars)`));
  assert.ok(!notice.includes(`(${body.length + 5} raw chars)`));
  assert.equal(f.notices.length, 1, "the explicit manual reply does not gain a duplicate action notice");
  f.notices.length = 0;
  const duplicate = f.add(body, "unknown-command", "copy-again");
  const witness = f.add("Still needed by the next request", "another-unknown-command", "dedup-unread");
  await f.emit("turn_end", { message: witness.assistant, toolResults: [witness.result], turnIndex: 4 });
  assert.equal(f.notices.length, 1, "automatic dedup has one confirmed-action notice, not a pre-flush hint plus success");
  assert.match(f.notices[0][0], /pruner: deduplicated 1 tool call/);
  assert.equal(f.notices[0][1], "info");
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw })).messages;
  assert.notEqual(projected.find(m => m.toolCallId === duplicate.id).content[0].text, body);
  assert.deepEqual(projected.find(m => m.toolCallId === witness.id), witness.result, "new unread output is not deduplicated");
  assert.equal(f.calls.length, 1);
  f.notices.length = 0;
  f.add(body, "unknown-command", "mixed-duplicate");
  f.add(buildLog, "npm run build", "mixed-packed");
  f.add("distinct new semantic source ".repeat(2000), "unknown-command", "mixed-semantic");
  const next = f.add("Newest unread evidence", "another-unknown-command", "mixed-unread");
  await f.emit("turn_end", { message: next.assistant, toolResults: [next.result], turnIndex: 8 });
  assert.equal(f.notices.length, 1, "multiple committed action kinds are combined in one automatic-flush notice");
  assert.match(f.notices[0][0], /pruned 2 tool batches.*deduplicated 1 tool call/);
  assert.equal(f.calls.length, 2);
});

test("stats distinguish completed usage from an in-flight summarizer request", async t => {
  const f = await fixture(t, { mode: "tui", showPruneStatusLine: true, defer: true });
  f.add("semantic source ".repeat(2000), "unknown-command", "usage-in-flight");
  const summary = f.statuses.get("context-prune").split("\n")[0];
  const finishing = f.finish(false);
  await waitForSummarizer(f);
  const status = f.statuses.get("context-prune");
  assert.equal(status.split("\n")[0], summary, "active progress belongs in detail, not the token metric");
  assert.match(status, /\nSummarizing 1\/1/);
  await changeSetting(f, "quietOversizedSkips");
  assert.equal(f.statuses.get("context-prune"), status, "settings redraws preserve active progress too");
  f.notices.length = 0;
  await f.commands.get("pruner").handler("stats", f.ctx);
  assert.ok(f.notices.some(([message]) => /no completed summarizer usage yet/.test(message)));
  assert.ok(!f.notices.some(([message]) => /no summarizer calls yet/.test(message)));
  f.releaseAll();
  await finishing;
  f.notices.length = 0;
  await f.commands.get("pruner").handler("stats", f.ctx);
  assert.ok(f.notices.some(([message]) => /completed usage records: 1/.test(message)));
});
