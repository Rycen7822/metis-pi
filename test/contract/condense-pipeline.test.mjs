import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import registerCondense from "../../extensions/condense.ts";
import { TokenEstimator } from "../../src/condense/token-estimator.ts";
import { summaryBudget, shouldBudgetFlush } from "../../src/condense/budget.ts";
import { toolResultStub } from "../../src/condense/pruner.ts";
import { captureBatch, projectBranchMessages, serializeBatchForSummarizer } from "../../src/condense/batch-capture.ts";
import goalExtension from "../../extensions/goal.ts";

const usage = { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const buildLog = Array.from({ length: 300 }, (_, i) => `building artifact ${i}: ` + "x".repeat(70)).join("\n") + "\nBUILD COMPLETE";

async function fixture(t, { reply = "[[1:bash]] Finished; evidence retained.", stopReason = "stop", defer = false, occ = false, capacity = false, pruneOn = "agent-message", showPruneStatusLine = false, chainCompression = { enabled: false } } = {}) {
  const workDir = fileURLToPath(new URL("../../.work/", import.meta.url));
  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, "condense-pipeline-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: capacity, reserveTokens: 500 }, contextPrune: {
    enabled: true, opportunisticCompaction: occ, showPruneStatusLine, minBatchChars: 5000, pruneOn, batchingMode: "agent-message",
    autoBudgetThreshold: 0.7, budgetTurnDelta: 0.2, frontierGapThresholdTokens: 1,
    chainCompression, purgeErrors: { enabled: false },
  } }));
  // Spill files use the session directory; inMemory() leaves it empty.
  const sm = SessionManager.create(dir, dir);
  const hooks = new Map(), tools = new Map(), calls = [], commands = new Map(), requests = [], events = createEventBus();
  const pendingFinishes = new Set();
  const api = "condense-local-proof";
  const model = { id: "summary", name: "summary", api, provider: "local", baseUrl: "http://invalid", reasoning: false,
    input: ["text"], contextWindow: 100000, maxTokens: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const releases = [];
  const stream = (_model, context, options) => {
    calls.push(context);
    requests.push(options);
    const callNumber = calls.length;
    const output = createAssistantMessageEventStream();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const reason = options.signal?.aborted ? "aborted" : typeof stopReason === "function" ? stopReason(callNumber) : stopReason;
      const message = { role: "assistant", api, provider: "local", model: "summary", content: [{ type: "text", text: typeof reply === "function" ? reply(callNumber) : reply }], stopReason: reason, errorMessage: reason === "error" ? "Offline summary provider failed" : undefined, timestamp: 1, usage };
      output.push({ type: reason === "error" ? "error" : "done", reason, message, error: message }); output.end(message);
    };
    options.signal?.addEventListener("abort", finish, { once: true });
    releases.push(finish);
    if (!defer) queueMicrotask(finish);
    return output;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  const pi = {
    events, getAllTools: () => [...tools.values()], on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); }, registerMessageRenderer() {},
    appendEntry(type, data) { sm.appendCustomEntry(type, data); },
    sendMessage(message) { sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
  };
  const notices = [], statuses = new Map(), widgets = [];
  const ctx = { sessionManager: sm, model, cwd: dir, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: capacity ? 96000 : 90000, contextWindow: 100000 }),
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local" }), getProviderAuth: async () => undefined },
    ui: { setStatus: (id, value) => statuses.set(id, value), setWidget: (id, value) => widgets.push([id, value]), notify: (message, type) => notices.push([message, type]) },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const fn of hooks.get(name) ?? []) result = await fn(event, ctx) ?? result;
    return result;
  };
  registerCondense(pi);
  await emit("session_start");
  let clock = 10;
  function add(body, command = "npm run build", id = `call-${clock}`, thinking) {
    const assistant = { role: "assistant", content: [...(thinking ? [{ type: "thinking", thinking }] : []), { type: "toolCall", id, name: "bash", arguments: { command } }], timestamp: clock++, stopReason: "toolUse" };
    const result = { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: body }], isError: false, timestamp: clock++ };
    sm.appendMessage(assistant); sm.appendMessage(result);
    return { assistant, result, id };
  }
  async function waitMaintenance() {
    for (;;) {
      const status = {}; events.emit("metis:condense-maintenance", status);
      if (!status.pending) return;
      await status.pending;
    }
  }
  function finish(settle = true) {
    const pending = (async () => {
      const message = { role: "assistant", content: [{ type: "text", text: "Final reply" }], stopReason: "stop", timestamp: clock++ };
      await emit("message_end", { message }); sm.appendMessage(message);
      if (settle) { await emit("turn_end", { message, toolResults: [], turnIndex: 0 }); await waitMaintenance(); }
    })();
    pendingFinishes.add(pending);
    pending.then(() => pendingFinishes.delete(pending), () => pendingFinishes.delete(pending));
    return pending;
  }
  t.after(async () => {
    await emit("session_shutdown");
    await Promise.allSettled(pendingFinishes);
    unregisterApiProviders(api);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  sm.appendMessage({ role: "user", content: "Build", timestamp: 1 });
  return { dir, sm, tools, calls, commands, requests, events, ctx, pi, emit, add, finish, notices, statuses, widgets,
    waitMaintenance, nextTimestamp: () => clock++,
    release: (index = releases.length - 1) => releases[index]?.(), releaseAll: () => releases.forEach(finish => finish()) };
}

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
  assert.equal(f.sm.getBranch().filter(e => e.type === "custom_message" && e.details?.representation === "packed").length, 1);
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 0);
});

test("automatic chain compression follows its switch and retains three recent tasks with exact recovery", async t => {
  for (const enabled of [false, true]) await t.test(`enabled=${enabled}`, async t => {
    const f = await fixture(t, { chainCompression: { enabled, rollingWindow: 3, fuseRangeSummary: false } });
    const body = "first task evidence\n".repeat(1400);
    for (let i = 0; i < 4; i++) {
      if (i) f.sm.appendMessage({ role: "user", content: `Task ${i}`, timestamp: f.nextTimestamp() });
      const call = f.add(body, "cat evidence.txt", `chain-${i}`, `THOUGHT_${i} ` + "x".repeat(5000));
      if (i === 0) {
        f.sm.appendMessage({ role: "assistant", timestamp: f.nextTimestamp(), stopReason: "toolUse",
          content: [{ type: "toolCall", id: "protected-receipt", name: "pi_spawn_agent", arguments: { task: "Inspect" } }] });
        f.sm.appendMessage({ role: "toolResult", timestamp: f.nextTimestamp(), toolCallId: "protected-receipt", toolName: "pi_spawn_agent",
          content: [{ type: "text", text: "PROTECTED_RECEIPT_VERBATIM" }], isError: false });
      }
      await f.finish();
    }
    const chains = () => f.sm.getBranch().filter(e => e.customType === "context-prune-chain");
    assert.equal(chains().length, enabled ? 1 : 0, "the fourth closing message counts before Pi persists it");
    const original = f.sm.buildSessionProjection().messages;
    const projected = (await f.emit("context", { messages: original })).messages;
    const text = JSON.stringify(projected);
    assert.equal(text.includes("THOUGHT_0"), !enabled);
    for (let i = 1; i < 4; i++) assert.match(text, new RegExp(`THOUGHT_${i}`));
    assert.match(text, /PROTECTED_RECEIPT_VERBATIM/);
    assert.equal(projected.filter(m => m.role === "user").length, enabled ? 5 : 4);
    assert.equal(projected.filter(m => m.role === "assistant" && m.content.some(b => b.text === "Final reply")).length, 4);
    const recalled = await f.tools.get("context_tree_query").execute("q", { toolCallIds: ["chain-0"] }, undefined, undefined, f.ctx);
    assert.equal(recalled.details.results[0].text, body);
    await f.emit("session_start");
    assert.deepEqual((await f.emit("context", { messages: original })).messages, projected);
    await f.finish();
    assert.equal(chains().length, enabled ? 1 : 0);
    assert.equal(f.calls.length, 1, "dedup and chain compression reuse the durable summary without another model call");
  });
});

test("automatic chain compression archives skipped small outputs and preserves them on persistence failures", async t => {
  for (const failure of [undefined, "chain", "archive"]) await t.test(failure ?? "mixed coverage", async t => {
    const f = await fixture(t, { chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: false } });
    const call = f.add(buildLog, "npm run build", "mixed-large", "Retain intermediate reasoning until a durable replacement exists. ".repeat(100));
    const small = f.add("UNSUMMARIZED_EVIDENCE", "cat small.txt");
    if (failure) {
      const append = f.sm.appendCustomEntry.bind(f.sm);
      f.sm.appendCustomEntry = (type, data) => {
        if (failure === "chain" && type === "context-prune-chain" || failure === "archive" && type === "context-prune-index" && data.backfilled && data.toolCalls.some(call => call.toolCallId === small.id)) throw new Error("chain disk failure");
        return append(type, data);
      };
    }
    await f.finish();
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, failure ? 0 : 1);
    assert.ok(f.sm.getBranch().some(e => e.details?.representation === "packed"), "the successful summary remains persisted");
    const projected = (await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages;
    if (failure) assert.match(JSON.stringify(projected), /UNSUMMARIZED_EVIDENCE/, "archiving alone cannot hide raw output");
    if (failure !== "archive") assert.equal((await f.tools.get("context_tree_query").execute("q", { toolCallIds: [small.id] }, undefined, undefined, f.ctx)).details.results[0].text, "UNSUMMARIZED_EVIDENCE");
    assert.equal((await f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id] }, undefined, undefined, f.ctx)).details.results[0].text, buildLog);
  });
});

test("automatic chain compression reuses durable summaries without a second paid fusion", async t => {
  const f = await fixture(t, { chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  for (let i = 0; i < 25; i++) f.add(`evidence-${i}\n` + (i === 24 ? "界" : "x").repeat(6000), `cat evidence-${i}.txt`);
  await f.finish();
  assert.equal(f.calls.length, 2);
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 2);
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 1);
  await f.emit("session_tree");
  await f.finish(false);
  assert.equal(f.calls.length, 2, "reload cannot turn mechanical chain compression into paid fusion");
});

for (const boundary of ["settled", "session_tree", "session_start", "session_shutdown"]) test(`final boundary retains refs and discards late summaries after ${boundary}`, async (t) => {
  const f = await fixture(t, { reply: "A short useful summary with no reference labels.", defer: true });
  const call = f.add("important detail\n".repeat(1500), "inspect-unknown-tool");
  const pending = f.finish();
  for (let i = 0; i < 600 && f.calls.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.calls.length, 1);
  const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()) };
  f.events.emit("metis:condense-project", request);
  assert.equal(request.busy, true);
  if (boundary !== "settled") await f.emit(boundary);
  f.release(); await pending;
  const summary = f.sm.getBranch().find(e => e.type === "custom_message" && e.details?.representation === "summary");
  if (boundary !== "settled") {
    assert.equal(summary, undefined);
    const messages = projectBranchMessages(f.sm.getBranch());
    assert.equal(messages.find(message => message.toolCallId === call.id).content[0].text, "important detail\n".repeat(1500));
    return;
  }
  assert.ok(summary);
  assert.match(summary.content, /t1/);
  assert.equal(summary.details.toolCallRefs.length, 1);
  const recall = await f.tools.get("context_tree_query").execute("q", { toolCallIds: ["t1"] }, undefined, undefined, f.ctx);
  assert.equal(recall.details.results[0].text, "important detail\n".repeat(1500));
  await f.finish(); assert.equal(f.calls.length, 1, "same history is not summarized again");
  const source = f.sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
  f.sm.appendContextEdit(source.id, { content: "CORRECTED_WITHOUT_OCC" });
  const effective = f.sm.buildSessionProjection().messages;
  const edited = (await f.emit("context", { messages: effective }))?.messages ?? effective;
  assert.match(JSON.stringify(edited), /CORRECTED_WITHOUT_OCC/);
  assert.ok(!edited.some(message => message.customType === "context-prune-summary"), "edited source invalidates its derived summary even without OCC");
});

test("session restore drops the previous queue while a tree switch keeps its own records and never reloads config", async (t) => {
  const f = await fixture(t);
  // A body that reaches the summarizer (buildLog packs into an archive instead).
  const body = "important detail\n".repeat(1500);
  // agent-message queues this batch and returns before the budget gate.
  const queued = f.add(body, "inspect-unknown-tool");
  await f.emit("turn_end", { message: queued.assistant, toolResults: [queued.result], turnIndex: 0 });
  assert.equal(f.calls.length, 0);

  // session_start reloads config from disk and boots the status + boot widget.
  const settings = { compaction: { enabled: false, reserveTokens: 500 }, contextPrune: {
    enabled: true, showPruneStatusLine: true, minBatchChars: 5000, pruneOn: "on-demand", batchingMode: "agent-message",
    autoBudgetThreshold: 0.7, budgetTurnDelta: 0.2, frontierGapThresholdTokens: 1,
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true }, purgeErrors: { enabled: false },
  } };
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify(settings));
  await f.emit("session_start");
  assert.deepEqual(f.widgets.filter(([id]) => id === "pruner-boot").map(([, value]) => value.length), [1]);
  assert.match(f.statuses.get("context-prune"), /prune: ON/);

  // The reload re-armed this branch's unindexed work: the gate flushes the
  // recaptured batch, never a stale queue entry.
  await f.emit("turn_end", {});
  assert.equal(f.calls.length, 1);
  assert.match(f.notices.map(([message]) => message).find((message) => message.includes("compacting")) ?? "", /compacting work recovered after reload/);
  const summary = f.sm.getBranch().find((entry) => entry.type === "custom_message" && entry.details?.representation === "summary");
  assert.ok(summary, "the restored index publishes a summary for the current branch");
  const recall = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [queued.id] }, undefined, undefined, f.ctx);
  assert.equal(recall.details.results[0].text, body);

  // A tree switch rebuilds the same records without re-summarizing indexed work,
  // re-arms work that only this branch holds, and (unlike session_start) neither
  // reloads config nor shows the boot widget.
  writeFileSync(join(f.dir, "settings.json"), JSON.stringify({ ...settings, contextPrune: { ...settings.contextPrune, showPruneStatusLine: false } }));
  const afterBody = "later detail\n".repeat(1800);
  f.add(afterBody, "inspect-after-tree");
  await f.emit("session_tree");
  await f.emit("turn_end", {});
  assert.equal(f.calls.length, 2, "the tree probe re-arms only this branch's unindexed work");
  assert.equal(f.widgets.filter(([id]) => id === "pruner-boot").length, 1);
  assert.match(f.statuses.get("context-prune"), /prune: ON/, "session_tree keeps the loaded config");
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
  const query = params => f.tools.get("context_tree_query").execute("q", { parentToolCallId: parent.id, maxBytes: 32768, ...params }, undefined, undefined, f.ctx);
  const recalled = (await query({})).details.results;
  assert.equal(recalled.length, 2);
  assert.equal(recalled.find(r => r.tool === "read").text, body + '\n\n[Structured content]\n{"complete":true}');
  assert.equal(recalled.find(r => r.tool === "bash").status, "ERROR");
  assert.match(JSON.stringify((await query({ component: "arguments" })).details), /skills\/example\/SKILL.md/);
});


for (const eager of [true, false]) test(`fused evidence preserves mutation, packs only successful logs and reloads exact output; turn_end=${eager}`, async (t) => {
  const f = await fixture(t);
  const path = join(f.dir, "fused-command.log"); writeFileSync(path, buildLog);
  const prefix = `Updated file.ts\n+saved\nCommand succeeded; log ${path}`;
  const call = f.add("unused", "npm run build", "fused-write");
  call.assistant.content[0].name = "write";
  call.assistant.content[0].arguments = { path: "file.ts", content: "saved", then_run: { command: "npm run build" } };
  call.result.toolName = "write";
  call.result.content = [{ type: "text", text: prefix }, { type: "text", text: buildLog }];
  call.result.details = { metisActionFusion: { version: 1, mutationStatus: "success", command: {
    command: "npm run build", status: "succeeded", exitCode: 0, outputBlock: 1,
    fullOutputPath: path, fullOutputBytes: Buffer.byteLength(buildLog), fullOutputComplete: true,
  } } };
  if (eager) await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  await f.finish();
  assert.equal(f.calls.length, 0);
  const query = () => f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id], maxBytes: 32768 }, undefined, undefined, f.ctx);
  assert.equal((await query()).details.results[0].text, `${prefix}\n${buildLog}`);
  await f.emit("session_start");
  assert.equal((await query()).details.results[0].text, `${prefix}\n${buildLog}`);
  const live = (await f.emit("context", { messages: projectBranchMessages(f.sm.getBranch()) })).messages;
  const visible = live.find(message => message.role === "toolResult" && message.toolCallId === call.id).content.map(block => block.text ?? "").join("\n");
  assert.match(visible, /Updated file.ts\n\+saved/);
  assert.match(visible, /lines omitted/);
  assert.match(visible, /BUILD COMPLETE/);
  assert.match(visible, /fused-command.log/);
});

test("goal continuation counters change only the appended message, preserving system instructions", async (t) => {
  const hooks = new Map(), tools = new Map();
  const sm = SessionManager.inMemory("/tmp/goal-prefix");
  const pi = { events: createEventBus(), on: (name, fn) => hooks.set(name, fn), registerCommand() {}, registerTool: t => tools.set(t.name, t),
    appendEntry: (type, data) => sm.appendCustomEntry(type, data), sendMessage() {} };
  goalExtension(pi);
  const ctx = { sessionManager: sm, hasUI: false, isIdle: () => true, hasPendingMessages: () => false };
  t.after(() => hooks.get("session_shutdown")({}, ctx));
  await tools.get("create_goal").execute("c", { objective: "Finish local work", token_budget: 10000 }, undefined, undefined, ctx);
  const before = await hooks.get("before_agent_start")({ systemPrompt: "FIXED" }, ctx);
  await hooks.get("agent_start")({}, ctx);
  await hooks.get("agent_end")({ messages: [{ role: "assistant", stopReason: "stop", usage, content: [{ type: "text", text: "Continue" }] }] }, ctx);
  const after = await hooks.get("before_agent_start")({ systemPrompt: "FIXED" }, ctx);
  assert.equal(before.systemPrompt, after.systemPrompt);
  assert.notEqual(before.message.content, after.message.content);
  assert.match(after.message.content, /Tokens used: 20/);
});


test("manual paid fusion budgets the full chain wrapper and retains concatenation on rejection", async t => {
  for (const rejected of [false, true]) await t.test(rejected ? "budget rejected" : "accepted", async t => {
    const f = await fixture(t, { reply: n => n <= 2 ? "界".repeat(2500) : rejected ? "界".repeat(3500) : "Fused evidence.",
      chainCompression: { enabled: true, rollingWindow: 100, fuseRangeSummary: true } });
    for (let i = 0; i < 26; i++) f.add(`evidence-${i}\n` + "界 ".repeat(3000), `cat evidence-${i}.txt`);
    await f.finish();
    assert.equal(f.calls.length, 2);
    assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-chain"));
    await f.commands.get("pruner").handler("compact", f.ctx);
    assert.equal(f.calls.length, 3);
    const chain = f.sm.getBranch().find(e => e.customType === "context-prune-chain").data;
    assert.equal(chain.rangeSummaryText, rejected ? undefined : "Fused evidence.");
    assert.ok((await f.emit("context", { messages: f.sm.buildSessionProjection().messages })).messages
      .some(m => m.metisDerived?.blockId === chain.blockId));
  });
});

test("pressure deferral keeps a frontier gap, permits packing and retries on the next real context", async t => {
  const f = await fixture(t);
  f.ctx.getContextUsage = () => ({ tokens: 60000, contextWindow: 100000 });
  const semantic = f.add("界".repeat(6000), "unknown-command", "deferred");
  await f.finish();
  assert.equal(f.calls.length, 0);
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.outcome, "deferred-budget");
  f.add(buildLog); await f.finish();
  assert.equal(f.calls.length, 0);
  assert.ok(f.sm.getBranch().some(e => e.details?.representation === "packed"));
  assert.ok(!f.sm.getBranch().some(e => e.customType === "context-prune-frontier"), "later packing cannot cross a deferred semantic gap");
  f.ctx.getContextUsage = () => ({ tokens: 75000, contextWindow: 100000 });
  const raw = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw })).messages;
  assert.equal(f.calls.length, 1);
  assert.ok(projected.some(m => m.customType === "context-prune-summary" && m.details?.representation === "summary"), "this request includes the just-persisted summary");
  assert.notEqual(projected.find(m => m.toolCallId === semantic.id).content[0].text, semantic.result.content[0].text);
  await f.emit("context", { messages: projected });
  assert.equal(f.calls.length, 1, "repeated projection does not regenerate completed evidence");
});

test("complete-message budgets include refs, reject without hiding and charge reported rejected output", async t => {
  const encoder = new TokenEstimator(); t.after(() => encoder.clear());
  let badReply;
  const f = await fixture(t, { showPruneStatusLine: true, reply: n => n === 1 ? badReply : "Inspection complete." });
  const call = f.add("界".repeat(6000), "unknown-command", "full-budget");
  const counts = await encoder.measure([call.result], [toolResultStub(call.result, undefined, "t1")]);
  const budget = summaryBudget(counts.before, counts.after, 1);
  badReply = "界".repeat(budget.limit); // Body alone fits; the real refs/wrapper do not.
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.match(f.statuses.get("context-prune"), /usage: 20 tokens/);
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
});

test("global TOML policy governs actual paid summary admission and full-message rejection", async t => {
  for (const [size, accepted] of [[300, true], [1000, false]]) await t.test(String(size), async t => {
    const f = await fixture(t, { reply: "论".repeat(size) });
    writeFileSync(join(f.dir, "metis-pi.toml"), '[contextPrune]\nenabled=true\nminBatchChars=0\nautoBudgetThreshold=0.7\n[contextPrune.chainCompression]\nenabled=false\n[contextPrune.summaryBudget]\nminGainTokens=512\nminGainFraction=0.1\nmaxProxyTokens=1000\ntargetBaseTokens=128\ntargetPerCallTokens=0\n');
    await f.emit("session_start");
    const call = f.add("甲".repeat(4000), "opaque-command", `toml-${size}`);
    await f.finish();
    assert.equal(f.calls.length, 1, "TOML minBatchChars overrides legacy JSON");
    const raw = f.sm.buildSessionProjection().messages;
    const projected = (await f.emit("context", { messages: raw }))?.messages ?? raw;
    assert.equal(projected.some(message => message.customType === "context-prune-summary"), accepted);
    if (!accepted) assert.equal(projected.find(message => message.toolCallId === call.id).content[0].text, call.result.content[0].text);
  });
});

test("legacy duplicate evidence never authorizes a growing mechanical stub", async t => {
  const f = await fixture(t);
  f.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: "legacy-small", resultTimestamp: 5,
    toolName: "bash", args: { command: "unknown-command" }, resultText: "OK", isError: false, turnIndex: -1, timestamp: 4 }] });
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
  const f = await fixture(t, { stopReason });
  const body = "important detail\n".repeat(1800), call = f.add(body, "inspect-unknown-tool");
  await f.finish();
  const metric = f.sm.getBranch().findLast(entry => entry.customType === "context-prune-flush-metrics").data;
  assert.equal(metric.outcome, "error"); assert.equal(metric.reason, "summarizer-failed");
  assert.match(metric.error, stopReason === "error" ? /Offline summary provider failed/ : /length-truncated/);
  const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()) };
  f.events.emit("metis:condense-project", request);
  assert.ok(request.messages.some(message => message.toolCallId === call.id && message.content[0].text === body));
  assert.ok(!request.messages.some(message => message.customType === "context-prune-flush-metrics"));
  await f.finish(); assert.equal(f.calls.length, 2, "failed batches remain available for retry");
});

test("effective rescan preserves raw frontier ordinals after global compaction", async t => {
  const f = await fixture(t, { occ: true });
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
    const next = f.add(`NEW_${i} ` + "observation ".repeat(1600), "custom inspection");
    await f.emit("turn_end", { message: next.assistant, toolResults: [next.result], turnIndex: i });
    await f.finish();
    assert.equal(f.calls.length, i < 3 ? 1 : 2);
  }
});


test("capacity waiting imports temporary output archives without pruning their visible results", async t => {
  const f = await fixture(t, { occ: true, capacity: true });
  const temporary = join(f.dir, "temporary-native-output.log");
  writeFileSync(temporary, "ARCHIVED RAW OUTPUT");
  const call = f.add("VISIBLE RESULT TAIL", "unrecognized-command", "capacity-archive");
  call.result.details = { fullOutputPath: temporary };
  await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: 0 });
  rmSync(temporary);
  const recovered = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [call.id] }, undefined, undefined, f.ctx);
  assert.equal(recovered.details.results[0].text, "ARCHIVED RAW OUTPUT");
  const messages = projectBranchMessages(f.sm.getBranch());
  const projected = (await f.emit("context", { messages }))?.messages ?? messages;
  assert.match(JSON.stringify(projected), /VISIBLE RESULT TAIL/);
  await f.finish();
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
  const control = { role: "toolResult", toolCallId: "control", toolName: "pi_wait_agent", timestamp: 3,
    content: [{ type: "text", text: '{"state":"completed","exact":"' + "x".repeat(6000) + '"}' }], isError: false };
  f.sm.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "control", name: "pi_wait_agent",
    arguments: { run_ids: ["completed-run"] } }], timestamp: 2, stopReason: "toolUse" });
  f.sm.appendMessage(control);
  f.add("ordinary output\n".repeat(1800), "cat ordinary.txt", "ordinary");
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert(!JSON.stringify(f.calls[0]).includes("completed-run"));
  const messages = projectBranchMessages(f.sm.getBranch());
  const projected = (await f.emit("context", { messages }))?.messages ?? messages;
  assert.deepEqual(projected.find(m => m.role === "toolResult" && m.toolCallId === "control"), control);
});

test("automatic and manual chunks keep durable progress through a failure inside one assistant turn", async t => {
  for (const path of ["automatic", "manual"]) await t.test(path, async t => {
    let fail = true;
    const f = await fixture(t, { stopReason: n => fail && n === 2 ? "error" : "stop",
      chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: false } });
    const ids = Array.from({ length: 130 }, (_, i) => `large-chain-${i}`);
    f.sm.appendMessage({ role: "assistant", timestamp: 2, stopReason: "toolUse", content: ids.map((id, i) => ({
      type: "toolCall", id, name: "bash", arguments: { command: `cat evidence-${i}.txt` },
    })) });
    for (const [i, id] of ids.entries()) f.sm.appendMessage({ role: "toolResult", toolCallId: id, toolName: "bash",
      content: [{ type: "text", text: `evidence-${i}\n` + "x".repeat(6000) }], isError: false, timestamp: 3 + i });
    f.sm.appendMessage({ role: "user", content: "A separate task", timestamp: 200 });
    f.add("later task output\n".repeat(1400), "cat later.txt", "later-task");
    const flush = () => path === "automatic" ? f.finish() : f.commands.get("pruner").handler("now", f.ctx);
    const summaries = () => f.sm.getBranch().filter(e => e.customType === "context-prune-summary");
    await flush();
    const attempted = f.calls.length;
    assert(attempted >= 2 && attempted <= 3, "failure stops scheduling beyond the bounded request window");
    assert.equal(summaries().length, 1, "first chunk persists before the second fails");
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 0, "a partial flush cannot trigger automatic chain compression");
    const metric = f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data;
    assert.equal(metric.outcome, "partial");
    assert.equal(metric.processedBatches, 1);
    const refs = summaries()[0].details.toolCallRefs;
    assert(refs.length <= 24, "a long task uses bounded per-request work for the parallel window");
    const frontier = f.sm.getBranch().findLast(e => e.customType === "context-prune-frontier").data;
    assert.equal(frontier.lastAttemptedTurnIndex, 0, "frontier stays inside the original assistant turn");
    assert.equal(frontier.attemptedToolCallCount, refs.length);
    const recall = await f.tools.get("context_tree_query").execute("q", { toolCallIds: [refs[0].shortId] }, undefined, undefined, f.ctx);
    assert.equal(recall.details.results[0].text, "evidence-0\n" + "x".repeat(6000));
    fail = false;
    await f.emit("session_start");
    await flush();
    assert.equal(summaries().flatMap(e => e.details.toolCallRefs).length, ids.length + 1, "reload resumes all remaining occurrences");
    assert(f.calls.slice(attempted).every(call => !JSON.stringify(call).includes('"cat evidence-0.txt"')), "durable first chunk is never requested again");
    const count = f.calls.length;
    await flush();
    assert.equal(f.calls.length, count, "completed history stays settled");
    if (path === "manual") assert(f.notices.some(([message]) => /batches completed; remaining retained/.test(message)));
  });
});

test("summary requests reserve output space and local budget failures never request a provider", async t => {
  const f = await fixture(t);
  f.ctx.model.contextWindow = 6000;
  f.ctx.model.maxTokens = 2000;
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

test("parallel summaries commit in order within a three-record window and reject changed sources", async t => {
  for (const changed of [false, true]) await t.test(changed ? "source changed" : "out of order", async t => {
    const f = await fixture(t, { defer: true });
    for (let i = 0; i < 5; i++) {
      f.sm.appendMessage({ role: "user", content: `Task ${i}`, timestamp: 100 + i });
      f.add(`source-${i}\n` + "界".repeat(6000), `cat source-${i}.txt`, `parallel-${i}`);
    }
    const pending = f.finish();
    for (let i = 0; i < 600 && f.calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.length, 3, "requests overlap before any provider is released");
    f.release(2); f.release(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 3, "completed later requests do not create an unbounded backlog");
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 0);
    if (changed) f.sm.appendMessage({ role: "user", content: "New source", timestamp: 300 });
    f.release(0);
    let done = false;
    pending.finally(() => { done = true; });
    for (let i = 0; i < 600 && !done; i++) { await new Promise(resolve => setTimeout(resolve, 5)); f.releaseAll(); }
    await pending;
    const summaries = f.sm.getBranch().filter(e => e.customType === "context-prune-summary");
    assert.deepEqual(summaries.map(e => e.details.toolCallRefs[0].toolCallId), changed ? [] : Array.from({ length: 5 }, (_, i) => `parallel-${i}`));
    if (changed) {
      assert.equal(f.calls.length, 3);
      assert(f.requests.every(r => r.signal.aborted));
      assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.reason, "stale-context");
    } else assert.equal(f.calls.length, 5);
  });
});

test("a tree switch cancels concurrent requests, preserves the durable prefix and restores the suffix", async t => {
  const f = await fixture(t, { defer: true });
  for (let i = 0; i < 100; i++) f.add(`source-${i}\n` + (i >= 96 ? "界" : "x").repeat(6000), `cat source-${i}.txt`);
  const waitForCalls = async count => {
    for (let i = 0; i < 1000 && f.calls.length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.length, count);
  };
  const first = f.finish();
  await waitForCalls(3); f.release(0);
  for (let i = 0; i < 300 && !f.sm.getBranch().some(e => e.customType === "context-prune-summary"); i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const attempted = f.calls.length;
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 1);
  await f.emit("session_tree"); await first;
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-summary").length, 1);
  assert.equal(f.calls.length, attempted, "old lifecycle starts no later requests");
  assert(f.requests.slice(0, attempted).every(r => r.signal.aborted), "cancel propagates to every old provider request");
  let done = false;
  const resumed = f.finish().finally(() => { done = true; });
  for (let i = 0; i < 600 && !done; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    f.releaseAll();
  }
  assert(done, "remaining chunks finish after the switch");
  await resumed;
  assert(f.calls.slice(attempted).every(call => !JSON.stringify(call).includes('"cat source-0.txt"')));
  assert.equal(f.sm.getBranch().findLast(e => e.customType === "context-prune-flush-metrics").data.outcome, "summarized");
});


test("closed large write arguments become stable historical records with exact recall and edit recovery", async t => {
  const f = await fixture(t);
  const args = { path: "large.ts", content: "ORIGINAL_CODE\n".repeat(3000) };
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "large-write", name: "write", arguments: args }], stopReason: "toolUse", timestamp: 2 };
  const sourceId = f.sm.appendMessage(assistant);
  f.sm.appendMessage({ role: "toolResult", toolCallId: "large-write", toolName: "write", isError: false, content: [{ type: "text", text: "Successfully wrote file" }], timestamp: 3 });
  f.add("Recent evidence stays inline", "echo recent");
  await f.finish();
  assert.equal(f.calls.length, 0);
  const original = f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: original })).messages;
  assert.ok(JSON.stringify(projected).length < JSON.stringify(original).length / 2);
  assert.ok(!projected.some(m => m.role === "toolResult" && m.toolCallId === "large-write"));
  assert.ok(!projected.some(m => m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === "large-write")));
  assert.match(JSON.stringify(projected), /component=arguments/);
  const tool = f.tools.get("context_tree_query");
  let page = (await tool.execute("q", { toolCallIds: ["large-write@3"], component: "arguments" }, undefined, undefined, f.ctx)).details;
  let restored = page.results[0].text;
  while (page.nextCursor) { page = (await tool.execute("q", { toolCallIds: ["large-write@3"], component: "arguments", cursor: page.nextCursor }, undefined, undefined, f.ctx)).details; restored += page.results[0].text; }
  assert.deepEqual(JSON.parse(restored), args);
  await f.emit("session_start");
  assert.deepEqual((await f.emit("context", { messages: original })).messages, projected);
  f.sm.appendContextEdit(sourceId, { content: [{ ...assistant.content[0], arguments: { path: "large.ts", content: "CORRECTED" } }] });
  const effective = f.sm.buildSessionProjection().messages;
  const afterEdit = (await f.emit("context", { messages: effective }))?.messages ?? effective;
  assert.ok(afterEdit.some(m => m.role === "toolResult" && m.toolCallId === "large-write"));
  assert.match(JSON.stringify(afterEdit), /CORRECTED/);
});


for (const kind of ["failed", "protected", "mixed", "recent", "fusion-failed"]) {
  test(`argument compaction keeps ${kind} tool groups verbatim`, async t => {
    const f = await fixture(t);
    const args = { path: kind === "protected" ? "skills/rule.md" : "large.ts", content: "code ".repeat(6000) };
    const content = [{ type: "toolCall", id: "write-guard", name: "write", arguments: args }];
    if (kind === "mixed") content.push({ type: "toolCall", id: "other", name: "read", arguments: { path: "other.txt" } });
    f.sm.appendMessage({ role: "assistant", content, stopReason: "toolUse", timestamp: 2 });
    f.sm.appendMessage({ role: "toolResult", toolCallId: "write-guard", toolName: "write", timestamp: 3,
      isError: kind === "failed", content: [{ type: "text", text: "mutation result" }, { type: "text", text: "command failed" }],
      ...(kind === "fusion-failed" ? { details: { metisActionFusion: { version: 1, mutationStatus: "success", command: { command: "npm test", status: "failed", exitCode: 1, outputBlock: 1 } } } } : {}) });
    if (kind === "mixed") f.sm.appendMessage({ role: "toolResult", toolCallId: "other", toolName: "read", content: [{ type: "text", text: "other evidence" }], isError: false, timestamp: 4 });
    if (kind !== "recent") f.add("newest evidence", "echo newest");
    await f.finish();
    assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-arguments").length, 0);
    const original = f.sm.buildSessionProjection().messages;
    const rendered = (await f.emit("context", { messages: original }))?.messages ?? original;
    const write = rendered.find(m => m.role === "assistant" && m.content.some(b => b.id === "write-guard"));
    assert.deepEqual(write.content[0].arguments, args);
  });
}


test("shared chains preserve every endpoint, recover the block and stop deriving from an edited member", async t => {
  const f = await fixture(t, { pruneOn: "on-demand", chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true } });
  for (let i = 0; i < 2; i++) {
    f.sm.appendMessage({ role: "user", content: `shared-request-${i}`, timestamp: f.nextTimestamp() });
    f.add(`raw-shared-${i}`, `echo member-${i}`, `member-${i}`, "Independent intermediate reasoning. ".repeat(100));
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `shared-final-${i}` }], stopReason: "stop", timestamp: f.nextTimestamp() });
  }
  await f.emit("agent_settled"); await f.waitMaintenance();
  const block = f.sm.getBranch().find(e => e.customType === "context-prune-chain").data;
  const raw = () => f.sm.buildSessionProjection().messages;
  const projected = (await f.emit("context", { messages: raw() })).messages;
  assert.equal(f.calls.length, 0);
  assert.equal(projected.filter(m => m.metisDerived?.kind === "condense-chain").length, 1);
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
