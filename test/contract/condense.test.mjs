import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ToolCallIndexer } from "../../vendor/pi-condense/src/indexer.ts";
import { registerQueryTool } from "../../vendor/pi-condense/src/query-tool.ts";
import { pruneMessages } from "../../vendor/pi-condense/src/pruner.ts";
import { findSuperseded } from "../../vendor/pi-condense/src/supersede.ts";
import { hashToolResult } from "../../vendor/pi-condense/src/content-hash.ts";
import { DEFAULT_CONFIG } from "../../vendor/pi-condense/src/types.ts";
import { disableNetwork, captureRegistration, modelNamed, FAKE_API_KEY } from "../helpers/vendor-codex-provider.mjs";
import { assistantToolCall, toolResult } from "../helpers/vendor-codex-sessions.mjs";

test.beforeEach(disableNetwork);
const root = new URL("../../", import.meta.url);
const ENTRY = fileURLToPath(new URL("extensions/condense.ts", root));
const record = (id, text, timestamp = 3, extra = {}) => ({ toolCallId: id, toolName: "read", args: { path: "old.txt" }, resultText: text, isError: false, turnIndex: 1, timestamp: 4, resultTimestamp: timestamp, ...extra });
function queryFixture(records, sessionManager = SessionManager.inMemory("/tmp/condense-query")) {
  const origin = sessionManager.appendMessage({ role: "user", content: "before archive", timestamp: 0 });
  sessionManager.appendCustomEntry("context-prune-index", { toolCalls: records });
  const ctx = { sessionManager };
  const indexer = new ToolCallIndexer();
  indexer.reconstructFromSession(ctx);
  let tool;
  registerQueryTool({ registerTool: (value) => { tool = value; } }, indexer);
  const run = (params, signal) => tool.execute("query", params, signal, undefined, ctx);
  return { run, indexer, ctx, tool, origin };
}

test("recall pages round-trip Unicode, long lines, all repeated-ID occurrences and error status within one total budget", async () => {
  const a = '\uFEFFstart\\\n"中文😀\t'.repeat(3000) + "MIDDLE_FAILURE" + "末尾".repeat(7000);
  const b = "second occurrence";
  const f = queryFixture([record("same", a, 3, { isError: true, args: { huge: "x".repeat(10000) } }), record("same", b, 5)]);
  let cursor;
  const collected = new Map();
  let pages = 0;
  do {
    const result = await f.run({ toolCallIds: ["same"], maxBytes: 2048, cursor });
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 2048);
    const body = JSON.parse(text);
    assert.deepEqual(result.details, body);
    for (const page of body.results) {
      assert.equal(page.error, undefined);
      const prior = collected.get(page.occurrence) ?? "";
      assert.equal(page.offsetBytes, Buffer.byteLength(prior));
      collected.set(page.occurrence, prior + page.text);
      assert.equal(page.status, page.occurrence === "same@3" ? "ERROR" : "OK");
    }
    cursor = body.nextCursor;
    assert.equal(body.eof, cursor === null);
    assert.ok(++pages < 500);
  } while (cursor);
  assert.equal(collected.get("same@3"), a);
  assert.equal(collected.get("same@5"), b);
  assert.ok(pages > 2);
});

test("spill recall reaches the tail; archive loss cannot masquerade as a complete preview", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "condense-spill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "body.txt");
  const original = "α😀\n".repeat(4000) + "TAIL_ERROR";
  writeFileSync(file, original);
  const f = queryFixture([record("spill", "", 3, { spillPath: file, spillBytes: Buffer.byteLength(original), resultPreview: "DECEPTIVE_PREVIEW" })]);
  let cursor, restored = "";
  do {
    const body = JSON.parse((await f.run({ toolCallIds: ["spill"], maxBytes: 2048, cursor })).content[0].text);
    restored += body.results[0].text;
    cursor = body.nextCursor;
  } while (cursor);
  assert.equal(restored, original);
  rmSync(file);
  const result = await f.run({ toolCallIds: ["spill", "missing"] });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /DECEPTIVE_PREVIEW/);
  assert.ok(result.details.results.every((page) => page.error && !page.complete && page.text === undefined));
});

test("cursor survives index reconstruction, rejects another session/branch and honors cancellation", async () => {
  const f = queryFixture([record("original", "large😀".repeat(5000))]);
  const first = await f.run({ toolCallIds: ["original"], maxBytes: 2048 });
  const cursor = first.details.nextCursor;
  assert.ok(cursor);
  f.indexer.reconstructFromSession(f.ctx);
  const next = await f.run({ toolCallIds: ["original"], maxBytes: 2048, cursor });
  assert.equal(next.details.results[0].offsetBytes, Buffer.byteLength(first.details.results[0].text));
  const other = queryFixture([record("original", "large😀".repeat(5000))]);
  await assert.rejects(other.run({ toolCallIds: ["original"], cursor }), /no longer matches/);
  f.ctx.sessionManager.branch(f.origin);
  f.indexer.reconstructFromSession(f.ctx);
  await assert.rejects(f.run({ toolCallIds: ["original"], cursor }), /no longer matches/);
  await assert.rejects(f.run({ toolCallIds: ["original"], cursor: "garbage" }), /Invalid recall cursor/);
  await assert.rejects(f.run({ toolCallIds: ["original"] }, AbortSignal.abort()), /abort/i);
});

test("legacy records, persisted short refs and dedup aliases remain recoverable after reconstruction and compaction", async () => {
  const legacy = record("legacy", "LEGACY_BODY", undefined);
  delete legacy.resultTimestamp;
  const f = queryFixture([legacy, record("same", "FIRST_BODY", 3), record("same", "SECOND_BODY", 5)]);
  const refs = [{ shortId: "t1", toolCallId: "same", resultTimestamp: 3 }, { shortId: "t2", toolCallId: "same", resultTimestamp: 5 }];
  f.ctx.sessionManager.appendCustomEntry("context-prune-index", { toolCalls: [], backfilled: true, refs });
  f.indexer.registerSummaryRefs(refs);
  f.indexer.registerDuplicate("duplicate@8", "same@3", (type, data) => f.ctx.sessionManager.appendCustomEntry(type, data));
  f.ctx.sessionManager.appendCompaction("capacity summary", f.origin, 1000);
  f.indexer.reconstructFromSession(f.ctx);
  const body = (await f.run({ toolCallIds: ["legacy", "t1", "t2", "duplicate@8"] })).details;
  assert.deepEqual(body.results.map((page) => page.text), ["LEGACY_BODY", "FIRST_BODY", "SECOND_BODY", "FIRST_BODY"]);
  assert.equal(body.results[0].occurrence, "legacy");
  assert.equal(body.results[0].legacy, true);
  assert.equal(body.eof, true);
});

test("recovery grace preserves the returned page without reintroducing the source log", async () => {
  const f = queryFixture([record("raw", "BIG_SOURCE".repeat(5000))]);
  const response = await f.run({ toolCallIds: ["raw"], maxBytes: 2048 });
  const page = response.content[0].text;
  const recovery = record("query", page, 9, { toolName: "context_tree_query", args: { toolCallIds: ["raw"] } });
  f.ctx.sessionManager.appendCustomEntry("context-prune-index", { toolCalls: [recovery] });
  f.indexer.reconstructFromSession(f.ctx);
  const model = modelNamed("gpt-6-astra");
  const messages = [{ role: "user", content: "inspect", timestamp: 1 }, assistantToolCall(model, "raw", "read"), toolResult("raw", "read", "BIG_SOURCE".repeat(5000), 3), assistantToolCall(model, "query", "context_tree_query"), toolResult("query", "context_tree_query", page, 9)];
  const projected = pruneMessages(messages, f.indexer, undefined, undefined, undefined, 3).messages;
  assert.ok(projected.find((m) => m.toolCallId === "raw").content[0].text.length < 1000);
  assert.equal(projected.find((m) => m.toolCallId === "query").content[0].text, page);
  assert.deepEqual(DEFAULT_CONFIG.chainCompression, { enabled: true, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: true });
});

async function loadHost(t, { extraEntries = [], external = false, codex = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metis-condense-host-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  // Enable projection without invoking a summarizer. Production strategies are unchanged.
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { enabled: true, chainCompression: { enabled: false }, purgeErrors: { enabled: false } } }));
  const originalSettings = readFileSync(join(dir, "settings.json"), "utf8");
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const sm = SessionManager.inMemory(dir);
  for (const entry of extraEntries) entry(sm);
  const paths = [ENTRY];
  if (external) {
    const externalPath = join(dir, "external.ts");
    writeFileSync(externalPath, 'export default function(pi) { pi.registerTool({name:"context_tree_query",label:"external",description:"external",parameters:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:"external"}],details:{}}}}); }');
    paths.push(externalPath);
  }
  if (codex) paths.push(fileURLToPath(new URL("vendor/pi-codex-conversion/dist/index.js", root)));
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({ eventBus, cwd: dir, agentDir: dir, settingsManager, additionalExtensionPaths: paths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "CONDENSE_TEST" });
  await resourceLoader.reload();
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader, sessionManager: sm, ...(codex ? { model: modelNamed("gpt-6-astra") } : {}) });
  const errors = [], notices = [], statuses = new Map();
  t.after(async () => {
    try {
      await loaded.session.extensionRunner.emit({ type: "session_shutdown" });
      assert.deepEqual(errors, []);
    } finally {
      loaded.session.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  assert.deepEqual(loaded.extensionsResult.errors, []);
  await loaded.session.bindExtensions({ onError: (e) => errors.push(e), ...(codex ? {} : { uiContext: {
    notify: (message) => notices.push(message), setStatus: (key, value) => statuses.set(key, value),
    setWidget() {},
  } }) });
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), originalSettings);
  return { ...loaded, modelRuntime, sm, errors, notices, statuses, eventBus };
}

test("real host loads one built-in tool, preserves settings, and isolates cumulative summarizer costs", async (t) => {
  const h = await loadHost(t);
  const runner = h.session.extensionRunner;
  const tools = runner.getAllRegisteredTools().map((x) => x.definition);
  assert.equal(tools.filter((x) => x.name === "context_tree_query").length, 1);
  assert.ok(runner.getRegisteredCommands().some((x) => x.name === "pruner"));
  await h.session.prompt("/pruner recovery-grace");
  assert.ok(h.notices.some((text) => text.includes("Current recovery grace: 3 user-turn-group")), "the command must dispatch through AgentSession");
  const cost = { source: "pi-condense", totalCost: 0.02, inputTokens: 200, outputTokens: 10 };
  h.eventBus.emit("cost:external", cost);
  assert.equal(h.statuses.get("metis-condense-cost"), "prune usage: 210 tokens · $0.0200 (since session load)");
  h.eventBus.emit("cost:external", cost);
  h.eventBus.emit("cost:external", { ...cost, source: "unrelated", inputTokens: 99999 });
  assert.equal(h.statuses.get("metis-condense-cost"), "prune usage: 210 tokens · $0.0200 (since session load)");
  await runner.emit({ type: "session_start" });
  assert.equal(h.statuses.get("metis-condense-cost"), undefined);
  assert.equal(runner.getAllRegisteredTools().filter((x) => x.definition.name === "context_tree_query").length, 1);
  assert.deepEqual(h.errors, []);
});

test("external owner is detected after discovery, before built-in handlers register", async (t) => {
  const h = await loadHost(t, { external: true });
  const tools = h.session.extensionRunner.getAllRegisteredTools().map((x) => x.definition);
  assert.equal(tools.filter((x) => x.name === "context_tree_query").length, 1);
  assert.equal(tools.find((x) => x.name === "context_tree_query").label, "external");
  assert.ok(h.notices.some((text) => text.includes("built-in condense is inactive")));
});

test("Codex's real context handlers and final provider payload retain recovery tools and projected results", async (t) => {
  const model = modelNamed("gpt-6-astra");
  const raw = "ORIGINAL_LONG_RESULT_".repeat(5000);
  const call = assistantToolCall(model, "archived", "read");
  const result = toolResult("archived", "read", raw, 3);
  const h = await loadHost(t, { codex: true, extraEntries: [
    (sm) => sm.appendMessage({ role: "user", content: "inspect history", timestamp: 1 }),
    (sm) => sm.appendMessage(call), (sm) => sm.appendMessage(result),
    (sm) => sm.appendCustomEntry("context-prune-index", { toolCalls: [record("archived", raw)] }),
  ] });
  const messages = await h.session.extensionRunner.emitContext([{ role: "user", content: "inspect history", timestamp: 1 }, call, result]);
  assert.ok(JSON.stringify(messages).length < raw.length / 2);
  const provider = h.modelRuntime.getRegisteredNativeProvider("openai-codex");
  const capture = await captureRegistration(provider);
  const active = new Set(h.session.getActiveToolNames());
  assert.ok(active.has("context_tree_query"), "recall must actually be callable, not merely registered");
  const tools = h.session.extensionRunner.getAllRegisteredTools().map(({ definition: { name, description, parameters } }) => ({ name, description, parameters })).filter((tool) => active.has(tool.name));
  await capture.registration.streamSimple(model, { systemPrompt: "CONDENSE_TEST", messages, tools }, { apiKey: FAKE_API_KEY }).result();
  const body = capture.bodies[0];
  const recallSchema = body.tools.find((tool) => tool.name === "context_tree_query");
  assert.ok(recallSchema?.parameters.properties.cursor, "the final request must advertise pagination");
  const wireCall = body.input.find((item) => item.type === "function_call");
  const wireResult = body.input.find((item) => item.type === "function_call_output");
  assert.ok(wireCall && wireResult);
  assert.equal(wireResult.call_id, wireCall.call_id);
  assert.match(wireResult.output, /context_tree_query/);
  assert.doesNotMatch(wireResult.output, /No result provided/);
  assert.ok(!JSON.stringify(body).includes(raw));
  assert.ok(JSON.stringify(body).includes("archived"));
});


test("pruning a failed execution retains ERROR and its independent evidence reference", () => {
  const f = queryFixture([record("failed", "failure detail", 3, { isError: true })]);
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "failed", "read"),
    { ...toolResult("failed", "read", "failure detail"), isError: true }];
  const projected = pruneMessages(messages, f.indexer).messages;
  assert.equal(projected[1].isError, true);
  assert.match(projected[1].content[0].text, /status ERROR/);
  assert.match(projected[1].content[0].text, /ref `failed@3`/);
});

test("protected reads retain disjoint ranges, changed bytes and later failures", () => {
  const model = modelNamed("gpt-6-astra");
  const pair = (id, offset, text, isError = false) => [
    assistantToolCall(model, id, "read", { path: "/skills/a/SKILL.md", offset, limit: 80 }),
    { ...toolResult(id, "read", text), isError },
  ];
  const first = pair("first", 1, "instructions");
  for (const later of [pair("next", 81, "next page"), pair("next", 1, "changed instructions"), pair("next", 1, "instructions", true)]) {
    assert.deepEqual(findSuperseded([...first, ...later], () => true), []);
  }
  assert.deepEqual(findSuperseded([...first, ...pair("same", 1, "instructions")], () => true).map((c) => c.toolCallId), ["first"]);
});

test("duplicate body recall keeps each command, status, timestamp and short ref after reload", async () => {
  const first = record("first", "same output", 3, { toolName: "bash", args: { command: "test-a" } });
  const second = record("second", "same output", 8, { toolName: "bash", args: { command: "test-b" }, isError: true });
  const f = queryFixture([first]);
  f.indexer.registerDuplicate("second@8", "first@3", (type, data) => f.ctx.sessionManager.appendCustomEntry(type, data), second);
  const ref = f.indexer.getShortRefForToolCallId("second@8");
  f.indexer.reconstructFromSession(f.ctx);
  assert.deepEqual(f.indexer.getRecord(ref), second);
  const page = (await f.run({ toolCallIds: [ref] })).details.results[0];
  assert.equal(page.status, "ERROR");
  assert.deepEqual(JSON.parse(page.argsPreview), { command: "test-b" });
  assert.equal(page.occurrence, "second@8");
  assert.notEqual(hashToolResult("bash", "a  b"), hashToolResult("bash", "a b"));
});

test("legacy alias without its source reports unknown metadata and is not pruned", async () => {
  const f = queryFixture([record("first", "shared historic body")]);
  f.ctx.sessionManager.appendCustomEntry("context-prune-dedup-alias", { newToolCallId: "lost", newResultTimestamp: 8, originalToolCallId: "first", originalResultTimestamp: 3 });
  f.indexer.reconstructFromSession(f.ctx);
  const own = f.indexer.getRecord("lost@8");
  assert.equal(own?.metadataUnavailable, true);
  const page = (await f.run({ toolCallIds: ["lost@8"] })).details.results[0];
  assert.equal(page.status, "UNKNOWN");
  assert.match(page.error, /not verified output/);
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "lost", "read"), toolResult("lost", "read", "live source", 8)];
  assert.equal(pruneMessages(messages, f.indexer).messages[1], messages[1]);
});


test("legacy archive-only records never authorize pruning after rejected preparation or reload", () => {
  const legacy = record("legacy-only", "EXACT_LEGACY_OUTPUT");
  delete legacy.resultTimestamp;
  legacy.archiveOnly = true;
  const f = queryFixture([legacy]);
  const message = toolResult("legacy-only", "read", "EXACT_LEGACY_OUTPUT");
  delete message.timestamp;
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "legacy-only", "read"), message];
  assert.equal(f.indexer.isSummarized("legacy-only"), false);
  assert.equal(f.indexer.hasLegacyBareRecord("legacy-only"), false);
  assert.equal(pruneMessages(messages, f.indexer).messages[1], message);
});
