import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import registerCondense from "../../extensions/condense.ts";
import { captureBatch, projectBranchMessages, serializeBatchForSummarizer } from "../../src/condense/batch-capture.ts";
import goalExtension from "../../extensions/goal.ts";

const usage = { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const buildLog = Array.from({ length: 300 }, (_, i) => `building artifact ${i}: ` + "x".repeat(70)).join("\n") + "\nBUILD COMPLETE";

async function fixture(t, { reply = "[[1:bash]] Finished; evidence retained.", defer = false, occ = false, capacity = false, pruneOn = "agent-message", showPruneStatusLine = false } = {}) {
  const workDir = fileURLToPath(new URL("../../.work/", import.meta.url));
  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, "condense-pipeline-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: capacity, reserveTokens: 500 }, contextPrune: {
    enabled: true, opportunisticCompaction: occ, showPruneStatusLine, minBatchChars: 5000, pruneOn, batchingMode: "agent-message",
    autoBudgetThreshold: 0.7, budgetTurnDelta: 0.2, frontierGapThresholdTokens: 1,
    chainCompression: { enabled: true, rollingWindow: 0, fuseRangeSummary: true }, purgeErrors: { enabled: false },
  } }));
  // Spill files use the session directory; inMemory() leaves it empty.
  const sm = SessionManager.create(dir, dir);
  const hooks = new Map(), tools = new Map(), calls = [], events = createEventBus();
  const api = "condense-local-proof";
  const model = { id: "summary", name: "summary", api, provider: "local", baseUrl: "http://invalid", reasoning: false,
    input: ["text"], contextWindow: 100000, maxTokens: 10000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let release;
  const stream = (_model, context) => {
    calls.push(context);
    const output = createAssistantMessageEventStream();
    const finish = () => {
      const message = { role: "assistant", api, provider: "local", model: "summary", content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: 1, usage };
      output.push({ type: "done", reason: "stop", message }); output.end(message);
    };
    if (defer) release = finish; else queueMicrotask(finish);
    return output;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  const pi = {
    events, getAllTools: () => [...tools.values()], on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {},
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
  function add(body, command = "npm run build", id = `call-${clock}`) {
    const assistant = { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }], timestamp: clock++, stopReason: "toolUse" };
    const result = { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: body }], isError: false, timestamp: clock++ };
    sm.appendMessage(assistant); sm.appendMessage(result);
    return { assistant, result, id };
  }
  async function finish() {
    const message = { role: "assistant", content: [{ type: "text", text: "Final reply" }], stopReason: "stop", timestamp: clock++ };
    await emit("message_end", { message }); sm.appendMessage(message);
  }
  t.after(async () => {
    await emit("session_shutdown"); unregisterApiProviders(api);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  sm.appendMessage({ role: "user", content: "Build", timestamp: 1 });
  return { dir, sm, tools, calls, events, ctx, pi, emit, add, finish, notices, statuses, widgets, release: () => release?.() };
}

test("packing precedes the 5000-char gate, archives exact output, and never re-compresses settled history", async (t) => {
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

for (const boundary of ["settled", "session_tree", "session_start", "session_shutdown"]) test(`final boundary retains refs and discards late summaries after ${boundary}`, async (t) => {
  const f = await fixture(t, { reply: "A short useful summary with no reference labels.", defer: true });
  const call = f.add("important detail\n".repeat(700), "inspect-unknown-tool");
  const pending = f.finish();
  for (let i = 0; i < 30 && f.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
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
    assert.equal(messages.find(message => message.toolCallId === call.id).content[0].text, "important detail\n".repeat(700));
    return;
  }
  assert.ok(summary);
  assert.match(summary.content, /t1/);
  assert.equal(summary.details.toolCallRefs.length, 1);
  const recall = await f.tools.get("context_tree_query").execute("q", { toolCallIds: ["t1"] }, undefined, undefined, f.ctx);
  assert.equal(recall.details.results[0].text, "important detail\n".repeat(700));
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
  const body = "important detail\n".repeat(700);
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
  const afterBody = "later detail\n".repeat(700);
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


test("the existing minBatchChars gate skips 4999 characters and summarizes at 5000", async (t) => {
  const f = await fixture(t);
  f.add("a".repeat(4999), "unknown-command", "below"); await f.finish();
  assert.equal(f.calls.length, 0);
  f.add("b".repeat(5000), "unknown-command", "at-limit"); await f.finish();
  assert.equal(f.calls.length, 1);
});

test("effective rescan preserves raw frontier ordinals after global compaction", async t => {
  const f = await fixture(t, { occ: true });
  for (let i = 0; i < 12; i++) f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `old ${i}` }], timestamp: 100 + i });
  f.sm.appendCustomEntry("context-prune-frontier", { lastAttemptedToolCallId: "old", lastAttemptedTurnIndex: 11 });
  const kept = f.sm.appendMessage({ role: "user", content: "new effective task", timestamp: 200 });
  f.sm.appendCompaction("old summary", kept, 1000);
  f.sm.appendCustomEntry("metis-occ-state", { phase: "hold", work: 10, atWork: 0, atChars: 0 });
  f.add("FRESH_BODY ".repeat(700), "custom inspection", "fresh");
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
  f.add("FIRST_EVIDENCE ".repeat(500), "custom inspection");
  await f.finish();
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 4; i++) {
    const next = f.add(`NEW_${i} ` + "observation ".repeat(200), "custom inspection");
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


test("summary provider sees the retained test tail and bounded original argument excerpts", async (t) => {
  const f = await fixture(t);
  const tail = "FINAL_TEST_RESULT_SENTINEL: all checks completed";
  const text = Array.from({ length: 260 }, (_, i) => `${i % 12 === 0 ? "warning" : "progress"} ${i}: ${"x".repeat(150)}`).join("\n") + "\n" + tail;
  f.add(text);
  await f.finish();
  assert.equal(f.calls.length, 1);
  assert.ok(JSON.stringify(f.calls[0]).includes(tail), "packing's retained tail reaches the actual summary provider");
  const batch = { turnIndex: 0, timestamp: 1, assistantText: "plan ".repeat(5000), toolCalls: [{
    toolCallId: "large-write", toolName: "write", args: { path: "large.ts", content: "🙂".repeat(50000) },
    resultText: "log ".repeat(20000) + "FAILURE_AT_END", isError: true,
  }] };
  const input = serializeBatchForSummarizer(batch);
  assert.ok(input.length <= 32768);
  assert.match(input, /large\.ts/);
  assert.match(input, /FAILURE_AT_END/);
  assert.match(input, /Original text omitted/);
  assert.equal(input.isWellFormed(), true);
  assert.equal(serializeBatchForSummarizer({ ...batch, toolCalls: Array(1000).fill(batch.toolCalls[0]) }), undefined);
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
