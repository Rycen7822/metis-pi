import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, readFileSync, ReadStream, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, normalizeContext, type Api, type AssistantMessage, type Model,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry, ModelRuntime, SessionManager, estimateTokens, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import initialize from "../../extensions/session-recall.ts";
import { refreshRecall } from "../../src/pi-session-recall/runtime.ts";
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
      `#!/bin/sh\n${shellQuote(binaries[backend]!)} "$@"\nstatus=$?\n` +
      `printf '%s\\n' "$status" >> ${shellQuote(reached)}\nexit "$status"\n`, { mode: 0o755 });
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
      if (backend !== "node") assert.equal(readFileSync(reached, "utf8").trim(), "0",
        "the actual selected backend succeeded, rather than silently falling back");
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

async function queryFixture(t: TestContext, contextWindow = 1000, { provider = "recall-offline", id = "recall" } = {}) {
  const dir = temporaryDirectory(t), sessions = join(dir, "sessions");
  mkdirSync(sessions);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  let tool: ToolDefinition<any, Record<string, unknown>>;
  initialize({
    on: () => () => {},
    registerTool: (definition: ToolDefinition<any, Record<string, unknown>>) => { tool = definition; },
  } as unknown as ExtensionAPI);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const model: Model<Api> = { id, name: "Recall offline", provider, api: "openai-responses",
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
  const cancelled = await tool.execute("cancelled", { action: "query", params: { sessionPath, question: "What changed?" } },
    AbortSignal.abort(), undefined, ctx);
  assert.equal(cancelled.details.cancelled, true);
  assert.equal(captured.length, 0, "a cancelled read cannot dispatch a helper request");
});

test("hybrid with missing worker is explicit and does not change literal search", async t => {
  const { dir, sessions, tool, ctx } = await queryFixture(t);
  const previous = process.env.METIS_RECALL_RUNTIME_DIR;
  process.env.METIS_RECALL_RUNTIME_DIR = join(dir, "unavailable");
  t.after(() => {
    if (previous === undefined) delete process.env.METIS_RECALL_RUNTIME_DIR;
    else process.env.METIS_RECALL_RUNTIME_DIR = previous;
  });
  sessionFile(sessions, "only-literal", ["unique fallback"]);
  const run = (mode: string) => tool.execute("recall", {
    action: "search", params: { mode, query: "unique fallback" },
  }, undefined, undefined, ctx);
  const unavailable = await run("hybrid");
  assert.equal(unavailable.details.error, true);
  assert.match(JSON.stringify(unavailable.content), /literal search/);
  assert.equal((await run("literal")).details.matchCount, 1);
});

test("packaged hybrid Recall uses Semantic Search's Bekko model and respects a custom root", async t => {
  const modelDir = process.env.METIS_BEKKO_DIR;
  if (!modelDir || process.platform !== "linux" || process.arch !== "x64") return t.skip("requires a local Bekko model on Linux x64");
  const { dir, sessions, tool, ctx, captured } = await queryFixture(t);
  for (const key of ["METIS_RECALL_RUNTIME_DIR", "METIS_BEKKO_DIR"]) {
    const value = process.env[key];
    delete process.env[key];
    t.after(() => { if (value !== undefined) process.env[key] = value; });
  }
  const catalog = join(dir, "metis/neural-search/semantic/linux-x64");
  mkdirSync(join(catalog, "runtime-fixture"), { recursive: true });
  writeFileSync(join(catalog, "current"), "runtime-fixture\n");
  writeFileSync(join(catalog, "runtime-fixture/assets.json"), JSON.stringify({ models: { bekko128: { directory: modelDir } } }));

  const custom = join(dir, "custom");
  mkdirSync(custom);
  const session = sessionFile(custom, "evidence", ["Preserve the originals before building an index."]);
  const outside = sessionFile(sessions, "outside", ["Preserve the originals before building an index."]);
  ctx.sessionManager = SessionManager.create(dir, custom);
  writeFileSync(join(dir, "metis-pi.toml"), "[sessionRecall]\nbackgroundIndex = true\n");
  const run = (scope?: { kind: "session"; sessionPath: string }) => tool.execute("hybrid", {
    action: "search", params: { mode: "hybrid", query: "retain source history", scope },
  }, undefined, undefined, ctx);
  const initial = await run();
  assert.equal(initial.details.coverage, "partial");
  assert.equal(initial.details.reason, "index_not_ready");
  assert.equal(initial.details.matchCount, 0);

  const warmed = await refreshRecall(dir, custom, new AbortController().signal);
  assert.equal(warmed.coverage.complete, true);
  const results = await run({ kind: "session", sessionPath: session });
  assert.equal(results.details.coverage, "complete");
  assert.equal(results.details.engine, "exact");
  assert.equal(results.details.matchCount, 1);
  assert.match(JSON.stringify(results.content), /Preserve the originals/);
  assert.match(JSON.stringify(results.content), /evidence\.jsonl/);
  assert.equal((await run({ kind: "session", sessionPath: outside })).details.error, true);
  assert.equal(captured.length, 0, "hybrid retrieval cannot call the selected provider");
});

test("enhanced Recall is explicit, falls back within scope, and the configured path returns anchored branch evidence", async t => {
  if (!process.env.METIS_RECALL_RUNTIME_DIR || !process.env.METIS_BEKKO_DIR || process.platform !== "linux") {
    return t.skip("requires a staged native worker and local Bekko");
  }
  const { dir, sessions, tool, ctx, captured } = await queryFixture(t);
  const manager = SessionManager.inMemory(dir);
  const shared = manager.appendMessage({ role: "user", content: "\x1b[0mCONTROL_TEXT quartz buffer", timestamp: 0 });
  manager.appendMessage({ role: "user", content: "EXCLUDED_ID quartz buffer", timestamp: 0 });
  manager.branch(shared);
  const leafId = manager.appendMessage({ role: "user", content: "CURRENT_ID quartz buffer", timestamp: 0 });
  const sessionPath = saveSession(sessions, "anchors", manager);
  sessionFile(sessions, "decoy", ["OTHER_FILE CURRENT_ID quartz buffer"]);
  const scope = { kind: "branch", sessionPath, leafId };
  const call = (mode: string, query = "CURRENT_ID quartz buffer", range = scope, signal?: AbortSignal) => tool.execute("recall", {
    action: "search", params: { mode, query, scope: range },
  }, signal, undefined, ctx);
  const ordinary = await call("enhanced");
  assert.equal(ordinary.details.mode, "hybrid");
  assert.equal(ordinary.details.enhancedReason, "not_configured");
  const text = (result: typeof ordinary) => JSON.stringify(result.content);
  assert.match(text(ordinary), /CURRENT_ID quartz buffer/);
  assert.doesNotMatch(text(ordinary), /EXCLUDED_ID|OTHER_FILE/);
  assert.equal((await call("hybrid")).details.enhancedReason, undefined);

  const { METIS_RECALL_TEST_POTION, METIS_RECALL_TEST_YUANBAO, METIS_RECALL_TEST_PYTHON } = process.env;
  if (!METIS_RECALL_TEST_POTION || !METIS_RECALL_TEST_YUANBAO || !METIS_RECALL_TEST_PYTHON) {
    t.diagnostic("CUDA enhanced arm not run without local Potion, Yuanbao, and Python");
    return;
  }
  const config = join(dir, "metis-pi.toml");
  const configure = (python: string) => writeFileSync(config, "[sessionRecall.enhanced]\n" +
    `potionDir = ${JSON.stringify(METIS_RECALL_TEST_POTION)}\nmodelDir = ${JSON.stringify(METIS_RECALL_TEST_YUANBAO)}\n` +
    `python = ${JSON.stringify(python)}\n`);
  configure(METIS_RECALL_TEST_PYTHON);
  const original = readFileSync(sessionPath);
  const enhanced = await call("enhanced");
  assert.equal(enhanced.details.mode, "enhanced", text(enhanced));
  assert.equal(enhanced.details.matchCount, 1);
  assert.match(text(enhanced), /block 0 \| 0:24/);
  assert.match(text(enhanced), /CURRENT_ID quartz buffer/);
  assert.doesNotMatch(text(enhanced), /EXCLUDED_ID|OTHER_FILE|CONTROL_TEXT/);
  assert.ok(Number(enhanced.details.outputTokens) > 0);
  assert.ok(Number(enhanced.details.outputTokens) <= Number(enhanced.details.outputCap));

  configure(join(dir, "missing-python"));
  const unavailable = await call("enhanced");
  assert.equal(unavailable.details.mode, "hybrid");
  assert.ok(unavailable.details.enhancedReason);
  assert.match(text(unavailable), /CURRENT_ID quartz buffer/);
  assert.doesNotMatch(text(unavailable), /EXCLUDED_ID|OTHER_FILE/);
  const outside = await call("enhanced", "quartz", { ...scope, sessionPath: join(dir, "outside.jsonl") });
  assert.equal(outside.details.error, true);
  const waiting = join(dir, "scorer-waiting"), scorer = join(dir, "blocking-scorer");
  writeFileSync(scorer, `#!/bin/sh\nprintf '%s' "$$" > ${shellQuote(waiting)}\nexec /bin/sleep 20\n`, { mode: 0o755 });
  configure(scorer);
  const cancellation = new AbortController();
  const pending = call("enhanced", undefined, scope, cancellation.signal);
  let scorerPid: string | undefined;
  try {
    for (let i = 0; i < 300 && !scorerPid; i++) {
      if (existsSync(waiting)) scorerPid = readFileSync(waiting, "utf8");
      if (!scorerPid) await delay(10);
    }
    assert.ok(scorerPid, "a child of the real Recall worker reached the waiting scorer");
  } finally {
    cancellation.abort(new Error("stop enhanced Recall"));
  }
  assert.equal((await pending).details.cancelled, true);
  const stopped = () => {
    try {
      // Linux can temporarily retain a dead orphan as a zombie; it cannot keep processing data.
      return readFileSync(`/proc/${scorerPid}/stat`, "utf8").includes(") Z ");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  };
  for (let i = 0; i < 100 && !stopped(); i++) await delay(10);
  assert.ok(stopped(), "cancellation stopped the local scoring process, not just its caller");
  assert.deepEqual(readFileSync(sessionPath), original, "indexing and reranking never write the JSONL source");
  assert.equal(captured.length, 0, "both local search paths must not use the session provider");
});

test("Recall cancels an opened query stream before provider dispatch and closes its file", async t => {
  const { sessions, tool, ctx, captured } = await queryFixture(t);
  const sessionPath = sessionFile(sessions, "cancel-open-query", ["Evidence that must not reach a provider."]);
  const controller = new AbortController();
  const emit = ReadStream.prototype.emit;
  let closed: Promise<void> | undefined;
  t.mock.method(ReadStream.prototype, "emit", function (this: ReadStream, event: string, ...args: unknown[]) {
    if (event === "open" && this.path === sessionPath) {
      closed = new Promise(resolve => this.once("close", resolve));
      controller.abort(new Error("cancel an opened query file"));
    }
    return Reflect.apply(emit, this, [event, ...args]);
  });
  const result = await tool.execute("cancel-open", { action: "query", params: { sessionPath, question: "What changed?" } },
    controller.signal, undefined, ctx);
  assert.ok(closed, "the actual query reader opened the target file");
  await closed;
  assert.equal(result.details.cancelled, true);
  assert.equal(captured.length, 0, "a cancelled file read never dispatches a helper request");
});

test("Recall uses the current native runtime's dynamic auth endpoint, headers and env", async t => {
  const { sessions, tool, ctx, runtime, captured } = await queryFixture(t, 4096);
  const auth = t.mock.method(runtime, "getAuth", async () => ({ auth: { apiKey: "broker-key", baseUrl: "http://127.0.0.1:1/broker/v1",
    headers: { "x-recall-auth": "dynamic" } }, env: { RECALL_TEST_ENV: "resolved" } }));
  const sessionPath = sessionFile(sessions, "routing", ["routing decision"]);
  const result = await tool.execute("query", { action: "query", params: { sessionPath, question: "What was the decision?" } },
    undefined, undefined, ctx);
  assert.match(JSON.stringify(result.content), /Offline recalled answer/);
  assert.equal(auth.mock.callCount(), 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.model.baseUrl, "http://127.0.0.1:1/broker/v1");
  assert.equal(captured[0]!.options.apiKey, "broker-key");
  assert.equal(captured[0]!.options.headers?.["x-recall-auth"], "dynamic");
  assert.equal(captured[0]!.options.env?.RECALL_TEST_ENV, "resolved");
});

test("Recall bounds final normalized input for small-count giant messages, many matches and oversized questions", async t => {
  // An OpenAI-looking model ID from another provider must still use the native estimate.
  const { sessions, tool, ctx, captured } = await queryFixture(t, 1000, { id: "gpt-4o" });
  for (const [name, contents] of [
    ["giant", ["needle 界🙂 ".repeat(8000)]],
    ["many", Array.from({ length: 12 }, (_, i) =>
      `needle decision ${i} ${i === 0 ? "BEGIN_SETUP" : ""} ` + "x".repeat(1500) + (i === 11 ? " FINAL_STATE" : ""))],
    ["late-match", ["Earlier context ".repeat(2000) + "needle LATE_MATCH_DECISION " + "context 界🙂 ".repeat(1000)]],
  ] as const) {
    const sessionPath = sessionFile(sessions, name, [...contents]);
    const result = await tool.execute(name, { action: "query", params: { sessionPath, question: "needle" } }, undefined, undefined, ctx);
    assert.equal(result.details.wasWindowed, true);
    assert.equal(result.details.inputTokenCounter, "pi-estimate");
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

type QueryTranscript = ReturnType<typeof normalizeContext>["messages"];

function messageText(message: QueryTranscript[number]): string {
  return typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("");
}

async function openAIInputTokens(messages: QueryTranscript, id: "gpt-4" | "gpt-4o-2024-08-06"): Promise<number> {
  const { encoding_for_model } = await import("tiktoken");
  const encoding = encoding_for_model(id);
  try {
    return messages.reduce((tokens, msg) =>
      tokens + 3 + encoding.encode_ordinary(msg.role).length + encoding.encode_ordinary(messageText(msg)).length, 3);
  } finally {
    encoding.free();
  }
}

test("Recall keeps a Chinese middle decision inside the selected model's input budget", async t => {
  const id = "gpt-4o-2024-08-06";
  const { tool, ctx, sessions, captured } = await queryFixture(t, 1500, { provider: "openai", id });
  const sessionPath = sessionFile(sessions, "handover", Array.from({ length: 42 }, (_, i) =>
    i === 26 ? "工具栏：切换前先通知雨燕组。" : "当班记录已收到，后续回访安排正在核对。".repeat(10)));
  const run = (question: string) => tool.execute("window", { action: "query", params: { sessionPath, question } }, undefined, undefined, ctx);
  const result = await run("工具栏如何切换？");
  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.ok(JSON.stringify(request.context.messages).includes("切换前先通知雨燕组。"));
  const tokens = await openAIInputTokens(request.context.messages, id);
  assert.ok(tokens <= 1200, `assembled input: ${tokens}`);
  assert.equal(request.options.maxTokens, 300);
  assert.equal(result.details.inputTokenCounter, "o200k_base");
  assert.match(JSON.stringify((await run("请核对交接记录".repeat(400))).content), /exceed/);
  assert.equal(captured.length, 1, "over-budget question rejected before dispatch");
});

test("Recall budgets a clipped match and both gaps in chronological order", async t => {
  const id = "gpt-4";
  const { tool, ctx, sessions, captured } = await queryFixture(t, 1300, { provider: "openai", id });
  const contents = Array.from({ length: 36 }, () => "Routine background without a decision. ".repeat(350));
  contents[0] = "SETUP_START " + "Inspect the inventory. ".repeat(24);
  contents[21] = "Unrelated archive text.\n".repeat(400) + "\n\n## needle\n\n[decision] Keep the 𠮷🙂 label.\n" + contents[21];
  contents[35] += " FINAL_END";
  const sessionPath = sessionFile(sessions, "gap-budget", contents);
  const result = await tool.execute("gaps", { action: "query", params: { sessionPath, question: "needle" } }, undefined, undefined, ctx);
  assert.equal(result.details.wasWindowed, true);
  assert.equal(result.details.inputTokenCounter, "cl100k_base");
  assert.equal(captured.length, 1);
  const { messages } = captured[0]!.context;
  const text = messageText(messages.find(m => m.role === "user")!);
  const omitted = [...text.matchAll(/^\[\.\.\. (\d+) messages omitted \.\.\.\]$/gm)];
  const included = [...text.matchAll(/^\[User\]: /gm)];
  assert.equal(included.length + omitted.reduce((sum, gap) => sum + Number(gap[1]), 0), contents.length);
  assert.match(text, /SETUP_START[\s\S]+messages omitted[\s\S]+Keep the 𠮷🙂 label\.[\s\S]+messages omitted[\s\S]+FINAL_END/);
  assert.match(text, /message truncated/);
  assert.equal(Buffer.from(text).toString("utf8"), text);
  assert.ok(await openAIInputTokens(messages, id) <= 1040);
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
