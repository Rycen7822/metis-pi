import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, createEventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import registerCondense from "../../vendor/pi-condense/dist/index.js";
import { captureBatch, projectBranchMessages } from "../../vendor/pi-condense/dist/src/batch-capture.js";
import { spillOversizedBatch } from "../../vendor/pi-condense/dist/src/spill.js";
import { ToolCallIndexer } from "../../vendor/pi-condense/dist/src/indexer.js";
import { registerQueryTool } from "../../vendor/pi-condense/dist/src/query-tool.js";
import { DEFAULT_CONFIG } from "../../vendor/pi-condense/dist/src/types.js";
import { ExecOutputArchive } from "../../vendor/pi-codex-conversion/dist/tools/exec/output-archive.js";
import { createCodexExtensionRuntime } from "../../vendor/pi-codex-conversion/dist/extension/runtime.js";
import goalExtension from "../../extensions/goal.ts";

const usage = { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const buildLog = Array.from({ length: 300 }, (_, i) => `building artifact ${i}: ` + "x".repeat(70)).join("\n") + "\nBUILD COMPLETE";

async function fixture(t, { reply = "[[1:bash]] Finished; evidence retained.", defer = false, occ = false, capacity = false } = {}) {
  const workDir = fileURLToPath(new URL("../../.work/", import.meta.url));
  mkdirSync(workDir, { recursive: true });
  const dir = mkdtempSync(join(workDir, "condense-pipeline-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: capacity, reserveTokens: 500 }, contextPrune: {
    enabled: true, opportunisticCompaction: occ, showPruneStatusLine: false, minBatchChars: 5000, pruneOn: "agent-message", batchingMode: "agent-message",
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
    events, on(name, fn) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, registerMessageRenderer() {},
    appendEntry(type, data) { sm.appendCustomEntry(type, data); },
    sendMessage(message) { sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details); },
  };
  const ctx = { sessionManager: sm, model, cwd: dir, hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: capacity ? 96000 : 90000, contextWindow: 100000 }),
    modelRegistry: { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local" }), getProviderAuth: async () => undefined },
    ui: { setStatus() {}, setWidget() {}, notify() {} },
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
  return { dir, sm, tools, calls, events, ctx, pi, emit, add, finish, release: () => release?.() };
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
  const runtime = createCodexExtensionRuntime(f.pi);
  t.after(async () => { runtime.shutdownTransport(f.sm.getSessionId()); await runtime.sessions.shutdown(); await runtime.shutdownDiagnostics(); });
  assert.deepEqual(runtime.projectContextMessages(f.ctx), live, "actual Codex runtime consumes the settled condense projection");
  assert.deepEqual(live.slice(0, before.length), before, "later final replies do not rewrite old settled blocks");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sm.getBranch().filter(e => e.type === "custom_message" && e.details?.representation === "packed").length, 1);
  assert.equal(f.sm.getBranch().filter(e => e.customType === "context-prune-chain").length, 0);
});

test("one model decision at the final boundary retains code-owned refs and blocks speculative prewarm", async (t) => {
  const f = await fixture(t, { reply: "A short useful summary with no reference labels.", defer: true });
  const call = f.add("important detail\n".repeat(700), "inspect-unknown-tool");
  const pending = f.finish();
  for (let i = 0; i < 30 && f.calls.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  const request = { sessionId: f.sm.getSessionId(), messages: projectBranchMessages(f.sm.getBranch()) };
  f.events.emit("metis:condense-project", request);
  assert.equal(request.busy, true);
  const runtime = createCodexExtensionRuntime(f.pi);
  t.after(async () => { runtime.shutdownTransport(f.sm.getSessionId()); await runtime.sessions.shutdown(); await runtime.shutdownDiagnostics(); });
  const warming = { ...f.ctx, getSystemPrompt: () => { throw new Error("busy projection must stop prewarm before preparing a request"); } };
  assert.equal(runtime.startCompactionPrewarm(warming), undefined);
  assert.equal(runtime.waitForPrewarm(warming, "FIXED"), undefined);
  f.release(); await pending;
  const summary = f.sm.getBranch().find(e => e.type === "custom_message" && e.details?.representation === "summary");
  assert.ok(summary);
  assert.match(summary.content, /t1/);
  assert.equal(summary.details.toolCallRefs.length, 1);
  const recall = await f.tools.get("context_tree_query").execute("q", { toolCallIds: ["t1"] }, undefined, undefined, f.ctx);
  assert.equal(recall.details.results[0].text, "important detail\n".repeat(700));
  await f.finish(); assert.equal(f.calls.length, 1, "same history is not summarized again");
});

test("execution archives survive display eviction, and recall pins append-only snapshots across growth", async (t) => {
  const f = await fixture(t);
  const directory = join(f.dir, `${f.sm.getSessionId()}-blobs`);
  const archive = new ExecOutputArchive(directory, 256);
  t.after(() => archive.close());
  const original = "START\r\n" + "中文\u001b[31m".repeat(1500) + "FIRST_END";
  archive.append(original);
  const info = archive.info(); assert.ok(info);
  const assistant = { content: [{ type: "toolCall", id: "exec-original", name: "exec_command", arguments: { cmd: "producer" } }] };
  const batch = captureBatch(assistant, [{ toolCallId: "exec-original", timestamp: 3, isError: false, content: [{ type: "text", text: "DISPLAY_TAIL" }], details: info }], 1, 2);
  const indexer = new ToolCallIndexer();
  await spillOversizedBatch({ batch, indexer, config: DEFAULT_CONFIG, sessionDir: f.dir, sessionId: f.sm.getSessionId(), appendEntry: (type, data) => f.sm.appendCustomEntry(type, data) });
  let tool; registerQueryTool({ registerTool(t) { tool = t; } }, indexer);
  const first = (await tool.execute("q", { toolCallIds: ["exec-original"], maxBytes: 2048 }, undefined, undefined, f.ctx)).details;
  archive.append("LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT"); archive.close();
  let body = first, restored = first.results[0].text;
  while (body.nextCursor) {
    body = (await tool.execute("q", { toolCallIds: ["exec-original"], maxBytes: 2048, cursor: body.nextCursor }, undefined, undefined, f.ctx)).details;
    restored += body.results[0].text;
  }
  assert.equal(restored, original);
  assert.equal(first.results[0].source, "command-output");
  assert.equal(first.results[0].archiveComplete, true);
  assert.equal(indexer.getRecord("exec-original").spillPath, info.fullOutputPath, "polls share the durable producer log");
  assert.ok(existsSync(info.fullOutputPath));
  assert.equal(readFileSync(info.fullOutputPath, "utf8"), original + "LATER OUTPUT THAT MUST NOT CHANGE THE OLD SNAPSHOT");

  const temporary = join(f.dir, "native-bash.log"); writeFileSync(temporary, "native full output");
  const native = captureBatch({ content: [{ type: "toolCall", id: "bash-native", name: "bash", arguments: { command: "native" } }] }, [{ toolCallId: "bash-native", timestamp: 7, content: [{ type: "text", text: "native tail" }], details: { fullOutputPath: temporary } }], 2, 6);
  await spillOversizedBatch({ batch: native, indexer, config: DEFAULT_CONFIG, sessionDir: f.dir, sessionId: f.sm.getSessionId(), appendEntry() {} });
  rmSync(temporary);
  assert.equal((await tool.execute("q", { toolCallIds: ["bash-native"] }, undefined, undefined, f.ctx)).details.results[0].text, "native full output");
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

test("archive failure is explicit and incomplete captured prefixes are not reported as full output", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.dir, "not-a-directory"); writeFileSync(blocked, "file");
  const failed = new ExecOutputArchive(blocked, 1);
  assert.doesNotThrow(() => failed.append("command keeps running"));
  assert.equal(failed.info().fullOutputComplete, false);
  assert.match(failed.info().fullOutputError, /unavailable/i);
  failed.close();
  const partial = join(f.dir, "partial.log"); writeFileSync(partial, "captured prefix");
  const batch = captureBatch({ content: [{ type: "toolCall", id: "partial", name: "bash", arguments: { command: "producer" } }] },
    [{ toolCallId: "partial", timestamp: 4, content: [{ type: "text", text: "display tail" }], details: { fullOutputPath: partial, fullOutputComplete: false } }], 1, 3);
  const indexer = new ToolCallIndexer();
  await spillOversizedBatch({ batch, indexer, config: DEFAULT_CONFIG, sessionDir: f.dir, sessionId: f.sm.getSessionId(), appendEntry() {} });
  let tool; registerQueryTool({ registerTool(t) { tool = t; } }, indexer);
  const result = (await tool.execute("q", { toolCallIds: ["partial"] }, undefined, undefined, f.ctx)).details.results[0];
  assert.equal(result.text, "captured prefix");
  assert.equal(result.archiveComplete, false);
  assert.match(result.error, /incomplete/i);
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
