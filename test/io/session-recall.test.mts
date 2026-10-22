import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, estimateTokens, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import initialize from "../../extensions/session-recall.ts";
import { searchFiles, searchLines } from "../../src/pi-session-recall/search.ts";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);

function executable(name: string): string | undefined {
  return (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, name)).find(path => existsSync(path));
}
const binaries = { rg: executable("rg"), grep: executable("grep") };
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

function sessionFile(dir: string, name: string, contents: string[], cwd = dir): string {
  const manager = SessionManager.inMemory(cwd);
  for (const content of contents) manager.appendMessage({ role: "user", content, timestamp: 0 });
  return saveSession(dir, name, manager);
}

function saveSession(dir: string, name: string, manager: SessionManager): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"));
  return path;
}

for (const backend of ["rg", "grep", "node"] as const) {
  test(`Recall ${backend} has the same literal matching-line contract`, async t => {
    if (backend !== "node" && !binaries[backend]) return t.skip(`${backend} unavailable`);
    const root = temporaryDirectory(t), dir = join(root, "sessions"), bin = join(root, "bin");
    mkdirSync(dir); mkdirSync(bin);
    const reached = join(root, "backend-exits");
    if (backend !== "node") writeFileSync(join(bin, backend),
      `#!/bin/sh\n${shellQuote(binaries[backend]!)} "$@"\nstatus=$?\nprintf '%s\\n' "$status" >> ${shellQuote(reached)}\nexit "$status"\n`, { mode: 0o755 });
    // The searchable header must not inherit a random storage path containing
    // "-v" (including "-V"), which would add legitimate header matches.
    const cwd = "/recall-search-fixture";
    const one = sessionFile(dir, "one", ["Needle Needle -v two  spaces"], cwd);
    const two = sessionFile(dir, "two", ["needle", "NEEDLE"], cwd);
    writeFileSync(join(dir, "excluded.txt"), "needle\nneedle\nneedle\n");
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const results = await searchFiles("needle", dir);
      if (backend !== "node") assert.equal(readFileSync(reached, "utf8").trim(), "0", "the actual selected backend succeeded, rather than silently falling back");
      assert.deepEqual(results.sort((a, b) => a.path.localeCompare(b.path)), [{ path: one, count: 1 }, { path: two, count: 2 }]);
      assert.equal((await searchLines("needle", two, 1)).length, 1);
      assert.deepEqual(await searchFiles("-v", dir), [{ path: one, count: 1 }]);
      assert.deepEqual(await searchFiles("  ", dir), [{ path: one, count: 1 }], "literal whitespace is not trimmed or rejected");
      assert.deepEqual(await searchFiles("needle\nmissing", dir), [], "literal newlines are not a bag of patterns");
      await assert.rejects(searchFiles("", dir), /must not be empty/);
      await assert.rejects(searchLines("", one, 3), /must not be empty/);
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    }
  });
}

test("Recall cancellation reaches the Node reader and a running external search without fallback", async t => {
  const root = temporaryDirectory(t), dir = join(root, "sessions"), bin = join(root, "bin");
  mkdirSync(dir); mkdirSync(bin);
  sessionFile(dir, "records", Array.from({ length: 2000 }, () => "needle " + "x".repeat(100)));
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    const controller = new AbortController();
    const pending = searchFiles("needle", dir, controller.signal);
    setImmediate(() => controller.abort(new Error("cancel Node search")));
    await assert.rejects(pending, /cancel Node search/);
    if (process.platform === "win32") return;
    const ready = join(root, "external-ready"), fallback = join(root, "fallback-used");
    writeFileSync(join(bin, "rg"), `#!/bin/sh\nprintf ready > ${shellQuote(ready)}\nexec /bin/sleep 2\n`, { mode: 0o755 });
    writeFileSync(join(bin, "grep"), `#!/bin/sh\nprintf fallback > ${shellQuote(fallback)}\n`, { mode: 0o755 });
    const external = new AbortController();
    const searching = searchFiles("needle", dir, external.signal);
    for (let attempts = 0; !existsSync(ready) && attempts < 100; attempts++) await delay(10);
    assert.ok(existsSync(ready), "actual external process reached its controlled waiting phase");
    external.abort(new Error("cancel external search"));
    await assert.rejects(searching, /cancel external search/);
    assert.equal(existsSync(fallback), false, "cancellation does not become a second backend attempt");
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
});

function assistant(model: Model<Api>, text: string): AssistantMessage {
  return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

async function queryFixture(t: TestContext, contextWindow = 1000) {
  const dir = temporaryDirectory(t), sessions = join(dir, "sessions");
  mkdirSync(sessions);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  let tool: ToolDefinition<any, Record<string, unknown>>;
  initialize({ registerTool: (definition: ToolDefinition<any, Record<string, unknown>>) => { tool = definition; } } as unknown as ExtensionAPI);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const model: Model<Api> = { id: "recall", name: "Recall offline", provider: "recall-offline", api: "openai-responses",
    baseUrl: "http://127.0.0.1:1/original/v1", contextWindow, maxTokens: 500, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const captured: Array<{ model: Model<Api>; context: ReturnType<typeof normalizeContext>;
    options: NonNullable<Parameters<ModelRegistry["streamSimple"]>[2]> }> = [];
  runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "offline", models: [model],
    streamSimple: (requestModel, context, options) => {
      captured.push({ model: requestModel, context, options: options ?? {} });
      const stream = createAssistantMessageEventStream(), message = assistant(requestModel, "Offline recalled answer");
      stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
    } });
  const registry = new ModelRegistry(runtime);
  t.mock.method(registry, "getApiKeyAndHeaders", () => { assert.fail("Recall must not request another auth snapshot"); });
  const ctx: Partial<ExtensionToolContext> = { cwd: dir, model: registry.find(model.provider, model.id)!, modelRegistry: registry,
    sessionManager: SessionManager.inMemory(dir) };
  return { dir, sessions, tool: tool!, runtime, ctx: ctx as ExtensionToolContext, captured };
}

test("the public grouped Recall tool reads native string messages and rejects empty patterns", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t);
  const sessionPath = sessionFile(sessions, "native-string", ["unique-recall-string"]);
  const result = await tool.execute("search", { action: "search", params: { query: "unique-recall-string" } }, undefined, undefined, ctx);
  assert.match(JSON.stringify(result.content), /\[user\] unique-recall-string/);
  assert.equal(result.details.matchCount, 1);
  await assert.rejects(tool.execute("empty", { action: "search", params: { query: "" } }, undefined, undefined, ctx), /query|minLength|minimum/);
  const cancelled = await tool.execute("cancelled", { action: "query", params: { sessionPath, question: "What changed?" } }, AbortSignal.abort(), undefined, ctx);
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(captured.length, 0, "a cancelled read cannot dispatch a helper request");
});

test("Recall uses the current native runtime's dynamic auth endpoint, headers and env", async t => {
  const { sessions, tool, ctx, runtime, captured } = await queryFixture(t, 4096);
  const auth = t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "broker-key", baseUrl: "http://127.0.0.1:1/broker/v1",
    headers: { "x-recall-auth": "dynamic" } }, env: { RECALL_TEST_ENV: "resolved" } }));
  const sessionPath = sessionFile(sessions, "routing", ["routing decision"]);
  const result = await tool.execute("query", { action: "query", params: { sessionPath, question: "What was the decision?" } }, undefined, undefined, ctx);
  assert.match(JSON.stringify(result.content), /Offline recalled answer/);
  assert.equal(auth.mock.callCount(), 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.model.baseUrl, "http://127.0.0.1:1/broker/v1");
  assert.equal(captured[0]!.options.apiKey, "broker-key");
  assert.equal(captured[0]!.options.headers?.["x-recall-auth"], "dynamic");
  assert.equal(captured[0]!.options.env?.RECALL_TEST_ENV, "resolved");
});

test("Recall bounds final normalized input for small-count giant messages, many matches and oversized questions", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t);
  for (const [name, contents] of [
    ["giant", ["needle 界🙂 ".repeat(8000)]],
    ["many", Array.from({ length: 12 }, (_, i) => `needle decision ${i} ${i === 0 ? "BEGIN_SETUP" : ""} ` + "x".repeat(1500) + (i === 11 ? " FINAL_STATE" : ""))],
    ["late-match", ["Earlier context ".repeat(2000) + "needle LATE_MATCH_DECISION " + "context 界🙂 ".repeat(1000)]],
  ] as const) {
    const sessionPath = sessionFile(sessions, name, [...contents]);
    const result = await tool.execute(name, { action: "query", params: { sessionPath, question: "needle" } }, undefined, undefined, ctx);
    assert.equal(result.details.wasWindowed, true);
    const request = captured.at(-1)!;
    // Independent native input oracle counts the actual provider-facing system,
    // question, framing and every omission/truncation marker together.
    const input = request.context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    assert.ok(input <= Math.floor(ctx.model!.contextWindow * 0.8), `${name}: final native estimate ${input}`);
    assert.ok(request.options.maxTokens! <= Math.floor(ctx.model!.contextWindow * 0.2));
    const text = JSON.stringify(request.context.messages);
    assert.match(text, /omitted|truncated/);
    assert.match(text, /needle/);
    if (name === "late-match") assert.match(text, /LATE_MATCH_DECISION/, "an oversized matched record retains the matching neighborhood");
    if (name === "many") {
      assert.match(text, /BEGIN_SETUP/, "matching windows retain original setup context");
      assert.match(text, /FINAL_STATE/, "matching windows retain original final-state context");
    }
    const inputText = request.context.messages.map(message => typeof message.content === "string" ? message.content
      : message.content.filter(block => block.type === "text").map(block => block.text).join("\n")).join("\n");
    assert.equal(Buffer.from(inputText).toString("utf8"), inputText, "truncation never leaves an unmatched surrogate");
  }
  assert.equal(captured.length, 3);
  const sessionPath = sessionFile(sessions, "question", ["small content"]);
  const result = await tool.execute("question", { action: "query", params: { sessionPath, question: "q".repeat(8000) } }, undefined, undefined, ctx);
  assert.match(JSON.stringify(result.content), /question and instructions exceed/);
  assert.equal(captured.length, 3, "an impossible input is rejected before provider dispatch");
});

test("Recall preserves original historical messages beside native compaction summaries", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t, 4096);
  const manager = SessionManager.inMemory(sessions);
  manager.appendMessage({ role: "user", content: "SUPERSEDED_RAW_MESSAGE", timestamp: 0 });
  const kept = manager.appendMessage({ role: "user", content: "KEPT_STATE", timestamp: 0 });
  manager.appendCompaction("SUMMARY_DECISION", kept, 10000);
  const sessionPath = saveSession(sessions, "summary", manager);
  const result = await tool.execute("summary", { action: "query", params: { sessionPath, question: "What changed?" } }, undefined, undefined, ctx);
  assert.equal(result.details.messageCount, 2, "public count still describes historical message entries, excluding auxiliary summaries");
  const text = JSON.stringify(captured[0]!.context.messages);
  assert.match(text, /SUMMARY_DECISION/);
  assert.match(text, /KEPT_STATE/);
  assert.match(text, /SUPERSEDED_RAW_MESSAGE/);
});

test("a real compacted session keeps relevant original evidence under the final-input window", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t);
  const manager = SessionManager.inMemory(sessions);
  manager.appendMessage({ role: "user", content: "needle BEFORE_COMPACTION_ORIGINAL " + "context 界🙂 ".repeat(3000), timestamp: 0 });
  const kept = manager.appendMessage({ role: "user", content: "KEPT_LATER_MESSAGE", timestamp: 0 });
  manager.appendCompaction("SUMMARY_DIFFERENT_MATERIAL", kept, 30000);
  const sessionPath = saveSession(sessions, "compacted-window", manager);
  const result = await tool.execute("compacted-window", { action: "query", params: { sessionPath, question: "needle" } }, undefined, undefined, ctx);
  assert.equal(result.details.wasWindowed, true);
  const context = captured[0]!.context;
  assert.match(JSON.stringify(context.messages), /BEFORE_COMPACTION_ORIGINAL/);
  assert.ok(context.messages.reduce((sum, message) => sum + estimateTokens(message), 0) <= Math.floor(ctx.model!.contextWindow * 0.8));
});

test("historical Recall follows the original current leaf instead of mixing abandoned branch records", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t, 4096);
  const manager = SessionManager.inMemory(sessions);
  const shared = manager.appendMessage({ role: "user", content: "SHARED_SETUP", timestamp: 0 });
  manager.appendMessage({ role: "user", content: "ABANDONED_BRANCH_RECORD", timestamp: 0 });
  manager.branch(shared);
  manager.appendMessage({ role: "user", content: "CURRENT_BRANCH_RECORD", timestamp: 0 });
  const sessionPath = saveSession(sessions, "branches", manager);
  const searched = await tool.execute("branch-search", { action: "search", params: { query: "ABANDONED_BRANCH_RECORD" } }, undefined, undefined, ctx);
  assert.equal(searched.details.matchCount, 1, "existing file search spans all branches");
  await tool.execute("branch-query", { action: "query", params: { sessionPath, question: "What changed?" } }, undefined, undefined, ctx);
  const text = JSON.stringify(captured[0]!.context.messages);
  assert.match(text, /SHARED_SETUP/);
  assert.match(text, /CURRENT_BRANCH_RECORD/);
  assert.doesNotMatch(text, /ABANDONED_BRANCH_RECORD/);
});
