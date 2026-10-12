import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync, gunzipSync } from "node:zlib";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { METIS_EVENTS } from "../../src/collaboration.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions, streamSimple as streamSimpleOpenAICodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { FAKE_API_KEY, modelNamed } from "../helpers/native-provider.mjs";

const root = new URL("../../", import.meta.url);
const model = modelNamed("gpt-6-astra");
const responsesModel = { ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const key = "metisCodexRemoteCompaction";
const usage = (input = 100) => ({ input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (text, input = 100) => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: usage(input), stopReason: "stop", timestamp: Date.now() });
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const sse = events => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
function completed(output) {
  return { type: "response.completed", response: { id: "r", status: "completed", output, usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } } };
}
function answerEvents() {
  const item = { type: "message", id: "msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  return [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item }, completed([item]),
  ];
}
const answer = () => sse(answerEvents());
function checkpointEvents(n = 1) {
  const item = { type: "compaction", id: `cmp-${n}`, encrypted_content: `opaque-${n}`, status: "completed" };
  return [{ type: "response.created", response: { id: "r", status: "in_progress" } }, { type: "response.output_item.done", output_index: 0, item }, completed([item])];
}
async function host(t, {
  auto = false, condense = false, goal = false, execution = false, contextJournal = false, providerOverride = false, existing, response, compactResponse, normalResponse, other = false, routeModel = model, transport = "sse",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metis-codex-compact-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    [routeModel.provider]: {
      type: "oauth", access: FAKE_API_KEY, refresh: "offline-refresh", expires: Date.now() + 3_600_000,
    },
  }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextPrune: { enabled: true, opportunisticCompaction: true, chainCompression: { enabled: false }, purgeErrors: { enabled: false } } }));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const sm = existing ? SessionManager.open(existing, dir) : SessionManager.create(dir);
  if (!existing) {
    sm.appendMessage(user("ORIGINAL USER"));
    sm.appendMessage(assistant("old work ".repeat(100)));
    sm.appendMessage(user("SECOND USER"));
    sm.appendMessage(assistant("more work ".repeat(100), auto ? model.contextWindow - 10 : 100));
    sm.appendMessage(user("KEPT TAIL"));
  }
  if (goal) sm.appendCustomEntry("goal", { version: 2, action: "create", goal: {
    id: "checkpoint-goal", objective: "preserve the active goal during context recovery", status: "active", tokenBudget: 1, tokensUsed: 0,
  } });
  writeFileSync(join(dir, "metis-pi.toml"), "[contextPrune]\nenabled = true\nopportunisticCompaction = true\n[contextPrune.chainCompression]\nenabled = false\n[contextPrune.purgeErrors]\nenabled = false\n");
  const eventBus = createEventBus();
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1 }, retry: { enabled: false }, defaultThinkingLevel: "off", transport, cacheWarming: "off" });
  const paths = [fileURLToPath(new URL("extensions/codex-compaction.ts", root))];
  if (providerOverride) {
    const entry = join(dir, "configured-provider.ts");
    const { id, name, reasoning, input, contextWindow, maxTokens, cost } = routeModel;
    writeFileSync(entry, `export default function(pi) { pi.registerProvider(${JSON.stringify(routeModel.provider)}, {
      api: ${JSON.stringify(routeModel.api)}, baseUrl: ${JSON.stringify(routeModel.baseUrl)}, apiKey: ${JSON.stringify(FAKE_API_KEY)},
      models: [${JSON.stringify({ id, name, reasoning, input, contextWindow, maxTokens, cost, headers: { "X-Tenant": "tenant-A" } })}]
    }); }`);
    paths.push(entry);
  }
  if (contextJournal) {
    const entry = join(dir, "context-journal.ts");
    writeFileSync(entry, `export default function(pi) { pi.on("context", (event, ctx) => {
      ctx.sessionManager.appendCustomEntry("projection-stats", { requests: 1 });
      ctx.sessionManager.appendCustomMessageEntry("projection-summary", "PROJECTED DURABLE SUMMARY", false);
      return { messages: ctx.sessionManager.buildSessionProjection().messages };
    }); }`);
    paths.push(entry);
  }
  if (condense) paths.push(fileURLToPath(new URL("extensions/condense.ts", root)));
  if (goal) paths.push(fileURLToPath(new URL("extensions/goal.ts", root)));
  if (execution) paths.push(fileURLToPath(new URL("extensions/execution.ts", root)));
  if (other) {
    const entry = join(dir, "other-provider.ts");
    writeFileSync(entry, `export default function(pi) { pi.registerProvider("other-codex", { baseUrl:"https://offline.invalid/backend-api/codex", api:"openai-codex-responses", apiKey:${JSON.stringify(FAKE_API_KEY)}, models:[{ id:"other", name:"Other", reasoning:false, input:["text"], contextWindow:128000, maxTokens:16000, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} }] }); }`);
    paths.push(entry);
  }
  const loader = new DefaultResourceLoader({ eventBus, cwd: dir, agentDir: dir, settingsManager: settings, additionalExtensionPaths: paths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "COMPACTION TEST" });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, sessionManager: sm, settingsManager: settings,
    resourceLoader: loader, model: routeModel, thinkingLevel: "off",
  });
  assert.deepEqual(extensionsResult.errors, []);
  const errors = [], notices = [], bodies = [], headers = [], urls = [];
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /\/responses(?:\/compact)?$/);
    urls.push(String(url));
    const h = new Headers(options.headers);
    let bytes = typeof options.body === "string" ? Buffer.from(options.body) : Buffer.from(options.body);
    if (h.get("content-encoding") === "zstd") bytes = zstdDecompressSync(bytes);
    if (h.get("content-encoding") === "gzip") bytes = gunzipSync(bytes);
    const body = JSON.parse(bytes.toString()); bodies.push(body); headers.push(h);
    if (String(url).endsWith("/responses/compact")) {
      count++;
      if (compactResponse) return compactResponse({ body, sm, session, count });
      return Response.json({ object: "response.compaction", id: `compact-${count}`, output: [
        ...body.input.filter(item => item.role === "user"),
        { type: "compaction", id: `cmp-${count}`, encrypted_content: `opaque-${count}` },
      ], usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 } });
    }
    if (body.input.at(-1)?.type !== "compaction_trigger") return normalResponse ? normalResponse({ body }) : answer();
    count++;
    return response ? await response({ body, sm, session, count }) : sse(checkpointEvents(count));
  });
  await session.bindExtensions({ onError: e => errors.push(e), uiContext: {
    notify: message => notices.push(message), setStatus() {}, setWidget() {},
    theme: { fg: (_key, text) => text },
    confirm: async () => { assert.fail("internal request cancellation must not ask to pause Goal"); },
  } });
  t.after(async () => {
    try { await session.extensionRunner.emit({ type: "session_shutdown" }); assert.deepEqual(errors, []); }
    finally { session.dispose(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
  });
  return { session, sm, dir, bodies, headers, urls, notices, errors, runtime, eventBus };
}
const compactions = h => h.sm.getBranch().filter(e => e.type === "compaction");

test("native collaboration ignores malformed facts and preserves synchronous queries and remote ownership", async t => {
  const h = await host(t, { condense: true, goal: true, execution: true });
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const requests = [
    [METIS_EVENTS.executionStatus, { busy: "yes" }],
    [METIS_EVENTS.goalSnapshot, { other: true }],
    [METIS_EVENTS.occStatus, { deferGoal: "yes" }],
    [METIS_EVENTS.occFinished, { cancelled: "yes" }],
    [METIS_EVENTS.beforeRemoteCompact, { waits: [], signal: "not a signal" }],
    [METIS_EVENTS.condenseProject, { sessionId: h.sm.getSessionId(), messages: [], api: 7 }],
    [METIS_EVENTS.condenseMaintenance, { pending: 7 }],
    [METIS_EVENTS.codexCompactionOwner, { get ctx() { throw new Error("opaque ctx accessed"); }, owns: false }],
    [METIS_EVENTS.codexCompactionOwner, { model: { api: 7, provider: "openai" }, owns: false,
      sessionManager: { buildSessionProjection() { throw new Error("invalid model reached history"); }, getBranch() { return []; } } }],
    [METIS_EVENTS.codexCompactionOwner, { owns: false, sessionManager: { buildSessionProjection: 7, getBranch() { return []; } } }],
  ];
  for (const [channel, malformed] of requests) {
    for (const value of [undefined, null, [], malformed]) h.eventBus.emit(channel, value);
  }
  await Promise.resolve();
  assert.deepEqual(errors, [], "malformed events never reach domain consumers");
  assert.equal(h.bodies.length, 0);

  let busy = false, writes = 0;
  const executionStatus = { get busy() { return busy; }, set busy(value) { busy = value; writes++; } };
  h.eventBus.emit(METIS_EVENTS.executionStatus, executionStatus);
  assert.equal(busy, false, "the registered execution runtime has no running sessions");
  assert.equal(writes, 1, "the response is filled before emit returns");
  const goal = { snapshot: undefined };
  h.eventBus.emit(METIS_EVENTS.goalSnapshot, goal);
  assert.equal(goal.snapshot.objective, "preserve the active goal during context recovery");
  const occ = { deferGoal: false };
  h.eventBus.emit(METIS_EVENTS.occStatus, occ);
  assert.equal(occ.running, false);

  const ownership = [];
  t.after(h.eventBus.on(METIS_EVENTS.codexCompactionOwner, request => ownership.push(request.owns)));
  await h.session.compact().catch(error => {
    assert.deepEqual(ownership, [true], "the native caller receives its remote-owner response across extension entries");
    throw error;
  });
  assert.deepEqual(ownership, [true]);
  assert.equal(compactions(h).length, 1);
  assert.equal(h.bodies.length, 1, "the real remote owner excludes an OCC plaintext summary");
  assert.deepEqual(errors, []);
});

test("manual compaction persists a native checkpoint and resumes with it, not a textual marker", async t => {
  const h = await host(t, { condense: true });
  const result = await h.session.compact("Preserve the current goal").catch(error => { throw new Error(`${error.message}: ${h.notices.join("; ")}`); });
  const entry = compactions(h).at(-1), cp = entry.details[key];
  assert.match(result.summary, /^\[Metis Codex remote checkpoint /);
  assert.deepEqual(cp.history.map(i => i.role ?? i.type), ["user", "user", "compaction"]);
  assert.equal(cp.history.at(-1).encrypted_content, "opaque-1");
  assert.equal(cp.history.at(-1).status, undefined);
  assert.equal(h.bodies.length, 1, "OCC must not issue another plaintext summary");
  assert.equal(h.bodies[0].input.at(-1).type, "compaction_trigger");
  assert.equal(h.bodies[0].store, false);
  assert.equal(h.bodies[0].stream, true);
  assert.match(h.bodies[0].instructions, /Preserve the current goal/);
  assert.ok(!JSON.stringify(h.bodies[0].input).includes("KEPT TAIL"), "do not compact and then replay the kept tail twice");
  assert.equal(h.headers[0].get("chatgpt-account-id"), "offline-test");
  assert.equal(h.headers[0].get("x-codex-beta-features"), "remote_compaction_v2");
  await h.session.prompt("CONTINUE");
  const next = h.bodies.at(-1);
  assert.equal(next.input.filter(i => i.type === "compaction").length, 1);
  assert.equal(JSON.stringify(next).includes(cp.marker), false);
  assert.equal(JSON.stringify(next.input).split("KEPT TAIL").length - 1, 1);
  assert.equal(JSON.stringify(entry.details).includes(FAKE_API_KEY), false);
});

test("Codex transport under openai persists and replays its native encrypted checkpoint", async t => {
  const h = await host(t, { routeModel: { ...model, provider: "openai" } });
  const result = await h.session.compact();
  assert.match(result.summary, /^\[Metis Codex remote checkpoint /);
  assert.equal(h.bodies[0].input.at(-1).type, "compaction_trigger");
  assert.equal(h.headers[0].get("x-codex-beta-features"), "remote_compaction_v2");
  await h.session.prompt("CONTINUE");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.equal(JSON.stringify(h.bodies.at(-1)).includes(result.summary), false);
});

test("official Responses preserves the complete compacted window across reload and repeated compaction", async t => {
  const window = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "RETAINED USER" }] },
    { type: "compaction", id: "compact-checkpoint", encrypted_content: "opaque-responses" },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "RETAINED ANSWER" }] },
    { type: "function_call", call_id: "retained-call", name: "read", arguments: '{"path":"notes.md"}' },
    { type: "function_call_output", call_id: "retained-call", output: "RETAINED RESULT" },
  ];
  const h = await host(t, {
    routeModel: responsesModel, condense: true,
    compactResponse: () => Response.json({ object: "response.compaction", output: window }),
  });
  const result = await h.session.compact("Preserve the active goal");
  const entry = compactions(h).at(-1);
  assert.equal(entry.fromHook, true);
  assert.deepEqual(entry.details[key].history, window);
  assert.equal(h.urls[0], "https://api.openai.com/v1/responses/compact");
  assert.deepEqual(Object.keys(h.bodies[0]).sort(), ["input", "instructions", "model"]);
  assert.match(h.bodies[0].instructions, /Preserve the active goal/);
  assert.equal(h.headers[0].get("authorization"), `Bearer ${FAKE_API_KEY}`);
  assert.equal(h.bodies.length, 1, "OCC must not generate another summary");
  assert.ok(h.bodies.every(body => !body.input.some(item => item.type === "compaction_trigger")));
  assert.ok(h.headers.every(headers => !headers.has("x-codex-beta-features")));
  const next = await host(t, { routeModel: responsesModel, existing: h.sm.getSessionFile() });
  await next.session.prompt("AFTER RELOAD");
  const assertWindow = input => {
    const start = input.findIndex(item => item.content?.[0]?.text === "RETAINED USER");
    assert.ok(start >= 0);
    assert.deepEqual(input.slice(start, start + window.length), window);
  };
  assertWindow(next.bodies[0].input);
  assert.equal(JSON.stringify(next.bodies[0]).includes(result.summary), false);
  assert.equal(JSON.stringify(next.bodies[0].input).split("KEPT TAIL").length - 1, 1);
  await next.session.compact();
  const compactInput = next.bodies[next.urls.findIndex(url => url.endsWith("/responses/compact"))].input;
  assertWindow(compactInput);
  assert.equal(compactInput.filter(item => item.type === "compaction").length, 1);
  await next.session.prompt("AFTER SECOND COMPACT");
  assert.ok(next.bodies.at(-1).input.some(item => item.encrypted_content === "opaque-1"));
});

test("ordinary marker text in user messages, arguments and tool output never becomes a checkpoint", async t => {
  for (const routeModel of [model, responsesModel]) await t.test(routeModel.api, async sub => {
    const h = await host(sub, { routeModel });
    const literal = 'const MARKER = "[Metis Codex remote checkpoint ";';
    const call = { type: "toolCall", id: "read-source", name: "read", arguments: { path: literal } };
    h.sm.appendMessage({ ...assistant(""), content: [call], stopReason: "toolUse" });
    h.sm.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: "read", isError: false,
      content: [{ type: "text", text: literal }], timestamp: Date.now() });
    await h.session.prompt(`Explain this source: ${literal}`);
    const input = h.bodies.at(-1).input;
    assert.ok(input.every(item => !item.type?.startsWith("metis_")));
    assert.ok(JSON.stringify(input).includes("const MARKER"));
    assert.equal(compactions(h).length, 0);
  });
});

test("official Responses rejects invalid compacted windows without default summarization", async t => {
  for (const kind of ["missing", "empty", "incomplete", "stale"]) await t.test(kind, async sub => {
    const h = await host(sub, { routeModel: responsesModel,
      compactResponse({ sm }) {
        if (kind === "stale") sm.appendMessage(user("ARRIVED DURING COMPACTION"));
        return Response.json({ object: "response.compaction", status: kind === "incomplete" ? "incomplete" : "completed",
          output: kind === "missing" ? [] : [{ type: "compaction", encrypted_content: kind === "empty" ? "" : "opaque" }],
        });
      },
    });
    await assert.rejects(h.session.compact(), /cancel/i);
    assert.equal(compactions(h).length, 0);
    assert.equal(h.bodies.length, 1);
    assert.ok(h.urls[0].endsWith("/responses/compact"));
  });
});

test("a native plaintext summary that quotes a complete marker remains ordinary text", async t => {
  const h = await host(t, { routeModel: responsesModel });
  const marker = "[Metis Codex remote checkpoint 00000000-0000-0000-0000-000000000000]";
  const kept = h.sm.getBranch().find(entry => entry.type === "message" && entry.message.content === "KEPT TAIL");
  h.sm.appendCompaction(marker, kept.id, 100, {}, false);
  await h.session.prompt("CONTINUE AFTER PLAINTEXT SUMMARY");
  assert.ok(JSON.stringify(h.bodies.at(-1).input).includes(marker));
  assert.ok(h.bodies.at(-1).input.every(item => !item.type?.startsWith("metis_")));
});

test("official Responses uses remote compaction for automatic and overflow recovery", async t => {
  for (const reason of ["automatic", "overflow"]) await t.test(reason, async sub => {
    let ordinary = 0;
    const h = await host(sub, { routeModel: responsesModel, condense: true, auto: reason === "automatic",
      normalResponse() {
        if (++ordinary === 1 && reason === "overflow") return Response.json({
          error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." },
        }, { status: 400 });
        return answer();
      },
    });
    await h.session.prompt("CONTINUE AFTER CAPACITY RECOVERY");
    assert.equal(h.urls.filter(url => url.endsWith("/responses/compact")).length, 1);
    assert.equal(compactions(h).length, 1);
    assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"));
  });
});

test("official Responses retains native retries and cancellation for the compact endpoint", async t => {
  const h = await host(t, { routeModel: responsesModel,
    compactResponse({ count }) {
      if (count === 1) return Response.json({ error: { message: "rate limited" } },
        { status: 429, headers: { "retry-after-ms": "1" } });
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "after-retry" }] });
    },
  });
  await h.session.compact();
  assert.equal(h.bodies.length, 2);
  assert.deepEqual(h.bodies[0], h.bodies[1]);
  assert.equal(compactions(h).at(-1).details[key].history[0].encrypted_content, "after-retry");
  const aborted = await host(t, { routeModel: responsesModel,
    compactResponse({ session }) {
      session.abortCompaction();
      return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "aborted" }] });
    },
  });
  await assert.rejects(aborted.session.compact(), /cancel/i);
  assert.equal(compactions(aborted).length, 0);
});

test("auto compaction uses the same remote transport before the next inference", async t => {
  const h = await host(t, { auto: true, condense: true });
  await h.session.prompt("AFTER AUTO");
  assert.equal(compactions(h).length, 1);
  assert.equal(h.bodies[0].input.at(-1).type, "compaction_trigger");
  assert.ok(h.bodies.at(-1).input.some(i => i.type === "compaction"));
  assert.ok(JSON.stringify(h.bodies.at(-1)).includes("AFTER AUTO"));
  assert.equal(h.bodies.length, 2);
});

test("reload and repeated compaction replay the prior checkpoint without duplicating the retained tail", async t => {
  const first = await host(t);
  await first.session.compact();
  const file = first.sm.getSessionFile();
  const h = await host(t, { existing: file });
  await h.session.prompt("AFTER RELOAD");
  assert.equal(h.bodies[0].input.filter(i => i.type === "compaction").length, 1);
  h.sm.appendMessage(user("SECOND TAIL"));
  await h.session.compact();
  const body = h.bodies.at(-1);
  assert.equal(body.input.at(-1).type, "compaction_trigger");
  assert.equal(body.input.filter(i => i.type === "compaction").length, 1);
  assert.ok(JSON.stringify(body.input).includes("AFTER RELOAD"));
  assert.ok(!JSON.stringify(body.input).includes("SECOND TAIL"));
  assert.notEqual(compactions(h).at(-1).summary, compactions(first).at(-1).summary);
  const latest = compactions(h).at(-1).details[key].history.at(-1);
  await h.session.prompt("AFTER SECOND COMPACTION");
  assert.ok(h.bodies.at(-1).input.some(i => i.type === "compaction" && i.encrypted_content === latest.encrypted_content));
  assert.equal(JSON.stringify(h.bodies.at(-1)).includes("Metis Codex remote checkpoint"), false);
});

test("invalid or stale remote results explicitly cancel without default summarization or ledger mutation", async t => {
  for (const kind of ["missing", "duplicate", "incomplete", "stale"]) await t.test(kind, async sub => {
    const h = await host(sub, { response({ sm }) {
      if (kind === "stale") sm.appendMessage(user("ARRIVED DURING COMPACTION"));
      const events = checkpointEvents();
      if (kind === "missing") events.splice(1, 1);
      if (kind === "duplicate") events.splice(2, 0, events[1]);
      if (kind === "incomplete") events[2].type = "response.incomplete";
      return sse(events);
    } });
    await assert.rejects(h.session.compact(), /cancel/i);
    assert.equal(compactions(h).length, 0);
    assert.equal(h.bodies.length, 1);
    assert.ok(h.sm.getBranch().some(e => e.type === "message" && e.message.content === "ORIGINAL USER"));
  });
});

test("editing covered source invalidates opaque state and restores the edited canonical history", async t => {
  const h = await host(t);
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  await h.session.compact();
  h.sm.appendContextEdit(source.id, { content: "CORRECTED ORIGINAL" });
  await h.session.prompt("CONTINUE AFTER EDIT");
  const body = h.bodies.at(-1);
  assert.ok(JSON.stringify(body.input).includes("CORRECTED ORIGINAL"));
  assert.equal(JSON.stringify(body.input).includes("ORIGINAL USER"), false);
  assert.equal(body.input.some(i => i.type === "compaction"), false);
  assert.equal(JSON.stringify(body.input).includes("Metis Codex remote checkpoint"), false);
});

test("changing the model recovers the original history instead of replaying an incompatible checkpoint", async t => {
  const h = await host(t);
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("CHANGED MODEL");
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction"), false);
  assert.ok(JSON.stringify(h.bodies.at(-1).input).includes("old work"));
  assert.equal(JSON.stringify(h.bodies.at(-1)).includes("Metis Codex remote checkpoint"), false);
});

test("a prompted session with a stored system checkpoint replays native history and retains only authored users", async t => {
  const h = await host(t);
  await h.session.prompt("BEFORE COMPACT");
  h.sm.appendCustomMessageEntry("generated-note", "AGENT GENERATED NOTE", true);
  h.sm.appendMessage(user("NEW KEPT TAIL"));
  await h.session.compact();
  const entry = compactions(h).at(-1);
  assert.ok(entry.systemMessage, "exercise the real system+summary projection");
  const native = entry.details[key].history;
  assert.ok(native.filter(i => i.role === "user").some(i => JSON.stringify(i).includes("BEFORE COMPACT")));
  assert.equal(JSON.stringify(native).includes("AGENT GENERATED NOTE"), false, "do not turn custom summaries into retained user authority");
  await h.session.prompt("AFTER COMPACT");
  assert.ok(h.bodies.at(-1).input.some(i => i.type === "compaction"));
  assert.equal(JSON.stringify(h.bodies.at(-1)).includes(entry.summary), false);
});

test("an explicit compaction abort never falls back to plaintext or aborts the agent turn", async t => {
  const h = await host(t, { response({ session }) { session.abortCompaction(); return sse(checkpointEvents()); } });
  await assert.rejects(h.session.compact(), /cancel|abort/i);
  assert.equal(compactions(h).length, 0);
  assert.equal(h.bodies.length, 1);
  await h.session.prompt("STILL USABLE");
  assert.ok(JSON.stringify(h.bodies.at(-1)).includes("STILL USABLE"));
});

test("an account change restores originals and never sends another account's checkpoint", async t => {
  const h = await host(t);
  await h.session.compact();
  const access = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "second-offline-account" } })).toString("base64url") + ".x";
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "offline-refresh", expires: Date.now() + 3_600_000 } }));
  await h.session.prompt("NEW ACCOUNT");
  assert.equal(h.headers.at(-1).get("chatgpt-account-id"), "second-offline-account");
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction"), false);
  assert.ok(JSON.stringify(h.bodies.at(-1)).includes("old work"));
});

test("a different provider keeps native compaction and recovers raw Codex history before summarizing", async t => {
  const h = await host(t, { other: true });
  await h.session.compact();
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  h.sm.appendMessage(user("OTHER TAIL"));
  const start = h.bodies.length;
  const result = await h.session.compact();
  assert.equal(h.bodies.length, start + 1);
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction_trigger" || i.type === "compaction"), false);
  assert.ok(JSON.stringify(h.bodies.at(-1)).includes("old work"));
  assert.equal(result.summary, "OK");
  assert.equal(compactions(h).at(-1).details?.[key], undefined);
});

test("system deltas retain the original prompt and the effective tool loadout", async t => {
  const h = await host(t);
  await h.session.prompt("BEFORE LOADOUT CHANGE");
  h.session.setActiveToolsByName(["read"]);
  await h.session.prompt("AFTER LOADOUT CHANGE");
  h.sm.appendMessage(user("KEPT AFTER CHANGE"));
  await h.session.compact();
  const body = h.bodies.at(-1);
  assert.match(body.instructions, /COMPACTION TEST/);
  assert.ok(body.tools.some(tool => tool.name === "read"));
  assert.equal(body.tools.some(tool => tool.name === "write"), false);
});

for (const routeModel of [model, responsesModel]) test(`${routeModel.api}: a late covered edit cancels; user retry applies every context projection`, async t => {
  const h = await host(t, { goal: true, routeModel });
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  await h.session.compact();
  h.sm.appendCustomMessageEntry("goal-ui", "HIDDEN GOAL UI", true);
  h.sm.appendCustomMessageEntry("goal-continuation", "STALE GOAL CONTINUATION", false, { goalId: "completed-old-goal" });
  const before = h.bodies.length;
  const ended = [];
  t.after(h.session.subscribe(event => { if (event.type === "agent_end") ended.push(event); }));
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  let reads = 0;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (!options && ++reads === 2) h.sm.appendContextEdit(source.id, { content: "EDITED WHILE AUTHENTICATING" });
    return result;
  });
  await h.session.prompt("CONTINUE AFTER AUTH RACE");
  assert.equal(h.bodies.length, before, "a stale native request must send neither opaque nor raw input");
  assert.equal(ended.length, 1, "internal cancellation must not queue a competing Goal continuation");
  assert.equal(ended[0].messages.at(-1).stopReason, "aborted");
  const currentGoal = () => h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "goal").at(-1).data.goal;
  assert.equal(currentGoal().status, "active");
  assert.ok(h.notices.some(message => /cancelled.*Retry/.test(message)));
  await h.session.prompt("RETRY WITH CURRENT CONTEXT");
  const body = h.bodies.at(-1);
  assert.ok(JSON.stringify(body.input).includes("EDITED WHILE AUTHENTICATING"));
  assert.equal(JSON.stringify(body.input).includes("HIDDEN GOAL UI"), false);
  assert.equal(JSON.stringify(body.input).includes("STALE GOAL CONTINUATION"), false);
  assert.equal(body.input.some(item => item.type === "compaction"), false);
  assert.equal(JSON.stringify(body).includes("Metis Codex remote checkpoint"), false);
  assert.equal(currentGoal().status, "budgetLimited", "the explicit retry is accounted normally");
});

test("a history tail appended after context preparation cancels before the payload hook can accept it", async t => {
  const h = await host(t);
  await h.session.compact();
  const before = h.bodies.length, getAuth = h.runtime.getAuth.bind(h.runtime); let appended = false;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (options?.signal && !appended) { appended = true; h.sm.appendMessage(user("ADDED AFTER CONTEXT PREPARATION")); }
    return result;
  });
  await h.session.prompt("CONTINUE AFTER TAIL RACE");
  assert.equal(h.bodies.length, before, "the payload was built before the newly canonical user tail");
  await h.session.prompt("RETRY THE TAIL RACE");
  assert.ok(JSON.stringify(h.bodies.at(-1).input).includes("ADDED AFTER CONTEXT PREPARATION"));
  await h.session.prompt("KEEP THE RECOVERED TAIL");
  assert.ok(JSON.stringify(h.bodies.at(-1).input).includes("ADDED AFTER CONTEXT PREPARATION"), "recovery lasts until a fresh checkpoint");
  h.sm.appendMessage(user("KEPT AFTER RECOVERY"));
  await h.session.compact();
  await h.session.prompt("USE THE FRESH CHECKPOINT");
  assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"), "a new checkpoint is usable after invalidation");
});

test("Condense composition and legitimate context publication keep a valid checkpoint request", async t => {
  const h = await host(t, { condense: true, contextJournal: true });
  await h.session.compact();
  const before = h.bodies.length;
  await h.session.prompt("CONTINUE THROUGH ALL CONTEXT OWNERS");
  assert.equal(h.bodies.length, before + 1);
  assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"));
  assert.ok(JSON.stringify(h.bodies.at(-1).input).includes("PROJECTED DURABLE SUMMARY"));
  assert.equal(h.notices.some(message => /Request cancelled/.test(message)), false);
});

test("checkpoint replay preserves the native provider and configured model headers across reload", async t => {
  const h = await host(t, { providerOverride: true });
  const owner = h.runtime.getProvider(model.provider);
  const catalog = owner.getModels();
  await h.session.compact();
  await h.session.prompt("PRESERVE THE CONFIGURED REQUEST");
  assert.equal(h.runtime.getProvider(model.provider), owner, "checkpoint interception must not replace the native owner");
  assert.deepEqual(owner.getModels(), catalog);
  assert.equal(h.headers.at(-1).get("x-tenant"), "tenant-A");
  await h.session.reload();
  await h.session.prompt("PRESERVE CONFIGURATION AFTER RELOAD");
  assert.equal(h.headers.at(-1).get("x-tenant"), "tenant-A");
  assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"));
});


test("a late edit evicts only the active native session's cached Codex WebSocket before send", async t => {
  const sockets = [];
  class OfflineWebSocket extends EventTarget {
    constructor(url) {
      super(); this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      setImmediate(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event("open")); } });
    }
    send(text) {
      assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text));
      setImmediate(() => { if (this.readyState === 1) for (const event of answerEvents()) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); });
    }
    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    }
  }
  t.mock.method(globalThis, "WebSocket", function (url) { return new OfflineWebSocket(url); });
  const h = await host(t, { transport: "websocket-cached" });
  const provider = h.runtime.getProvider(model.provider), nativeStream = provider.streamSimple.bind(provider);
  const requestIds = [];
  t.mock.method(provider, "streamSimple", (m, context, options) => {
    if (options?.transport === "websocket-cached") requestIds.push(options.sessionId);
    return nativeStream(m, context, options);
  });
  await h.session.prompt("WARM THE REAL SESSION SOCKET");
  assert.equal(sockets.length, 1);
  const activeSocket = sockets[0];
  const unrelatedSession = "unrelated-offline-session";
  t.after(() => closeOpenAICodexWebSocketSessions(unrelatedSession));
  const unrelated = await streamSimpleOpenAICodexResponses(model, normalizeContext({ messages: [user("UNRELATED SESSION")] }), {
    apiKey: FAKE_API_KEY, sessionId: unrelatedSession, transport: "websocket-cached",
  }).result();
  assert.equal(unrelated.stopReason, "stop");
  const unrelatedSocket = sockets[1];
  await h.session.compact();
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  const getAuth = h.runtime.getAuth.bind(h.runtime); let reads = 0;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (!options && ++reads === 2) h.sm.appendContextEdit(source.id, { content: "EDITED AFTER WS CACHE" });
    return result;
  });
  const before = sockets.reduce((n, socket) => n + socket.sent.length, 0);
  const httpBefore = h.bodies.length;
  await h.session.prompt("CANCEL THE CACHED REQUEST");
  assert.deepEqual(requestIds, [h.sm.getSessionId(), h.sm.getSessionId()], "actual native main requests use the captured SessionManager ID");
  assert.equal(sockets.reduce((n, socket) => n + socket.sent.length, 0), before, "cached, new and fallback transports must send no stale frame");
  assert.equal(h.bodies.length, httpBefore, "an aborted WebSocket request must not fall back to an HTTP send");
  assert.equal(activeSocket.readyState, 3);
  assert.equal(unrelatedSocket.readyState, 1, "scoped cleanup must retain the other session's cache");
  assert.equal(h.session.messages.at(-1).stopReason, "aborted");
  await h.session.prompt("RETRY THE WS REQUEST");
  const sent = sockets.flatMap(socket => socket.sent).at(-1);
  assert.ok(JSON.stringify(sent.input).includes("EDITED AFTER WS CACHE"));
  assert.equal(sent.input.some(item => item.type === "compaction"), false);
});

test("a safety rejection hands off the real abort signal instead of cancelling owed continuation", async t => {
  const h = await host(t, { condense: true, response: () => sse([completed([])]) });
  const finished = [];
  const off = h.eventBus.on("metis:occ-finished", event => finished.push(event));
  t.after(off);
  await assert.rejects(h.session.compact(), /cancel/i);
  await h.session.extensionRunner.emit({ type: "agent_settled" });
  assert.ok(finished.length > 0);
  assert.equal(finished.at(-1).cancelled, false, "malformed checkpoint is not a user abort");
});

test("the resolved account is pinned to transport despite an A-B-A credential race", async t => {
  let ambient = "A";
  const other = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-B" } })).toString("base64url") + ".x";
  const h = await host(t, { response: () => { ambient = "A"; return sse(checkpointEvents()); } });
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    return ambient === "B" ? { ...result, auth: { ...result.auth, apiKey: other } } : result;
  });
  const provider = h.runtime.getProvider("openai-codex");
  const stream = provider.streamSimple.bind(provider);
  t.mock.method(provider, "streamSimple", (m, context, options) => {
    if (options?.headers?.["x-codex-beta-features"] === "remote_compaction_v2") ambient = "B";
    return stream(m, context, options);
  });
  await h.session.compact();
  assert.equal(h.headers[0].get("chatgpt-account-id"), "offline-test");
  assert.equal(compactions(h).length, 1);
});

test("context-overflow recovery also compacts remotely before retrying ordinary inference", async t => {
  let ordinary = 0;
  const h = await host(t, { normalResponse() {
    if (++ordinary === 1) return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } }), { status: 400, headers: { "content-type": "application/json" } });
    return answer();
  } });
  await h.session.prompt("AFTER OVERFLOW");
  assert.equal(ordinary, 2);
  assert.equal(compactions(h).length, 1);
  assert.equal(h.bodies.filter(body => body.input.at(-1)?.type === "compaction_trigger").length, 1);
  assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"));
});
