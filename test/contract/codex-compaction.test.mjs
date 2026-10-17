import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const newOAuthKey = "x." + Buffer.from(JSON.stringify({ client_id: "dynamic_agent_client",
  "https://api.openai.com/auth": { per_user_salt: "offline", encrypted_auth_metadata: "offline" },
})).toString("base64url") + ".x";
function writeCodexLogin(dir, accountId = "offline-test") {
  const access_token = "x." + Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url") + ".x";
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token, account_id: accountId } }));
}
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
  oauth = routeModel.api !== "openai-responses", codexAuth = "cli", credential,
  beforeBind, modelsConfig,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metis-codex-compact-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.PI_CODING_AGENT_DIR = dir;
  const codexDir = join(dir, "codex");
  mkdirSync(codexDir);
  process.env.CODEX_HOME = codexDir;
  const legacyCredential = { type: "oauth", access: FAKE_API_KEY, refresh: "offline-refresh", expires: Date.now() + 3_600_000 };
  const hybrid = oauth && routeModel.api === "openai-responses";
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    [routeModel.provider]: credential ?? (oauth ? { ...legacyCredential, access: hybrid ? newOAuthKey : FAKE_API_KEY,
      ...(hybrid ? { clientId: "dynamic_agent_client" } : {}),
    } : { type: "api_key", key: FAKE_API_KEY }),
    ...(hybrid && codexAuth === "pi" ? { "openai-codex": legacyCredential } : {}),
  }));
  if (hybrid && codexAuth === "cli") writeCodexLogin(codexDir);
  if (modelsConfig) writeFileSync(join(dir, "configured-models.json"), JSON.stringify(modelsConfig));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"),
    modelsPath: modelsConfig ? join(dir, "configured-models.json") : null,
    modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  await runtime.refresh({ allowNetwork: false });
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
    const projection = contextJournal === "raw"
      ? 'ctx.sessionManager.getBranch().filter(entry => entry.type === "message").map(entry => entry.message)'
      : contextJournal === "drop-summary" ? 'event.messages.filter(message => message.role !== "compactionSummary")'
        : "ctx.sessionManager.buildSessionProjection().messages";
    writeFileSync(entry, `export default function(pi) { pi.on("context", (event, ctx) => {
      ctx.sessionManager.appendCustomEntry("projection-stats", { requests: 1 });
      ctx.sessionManager.appendCustomMessageEntry("projection-summary", "PROJECTED DURABLE SUMMARY", false);
      return { messages: ${projection} };
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
    let bytes = Buffer.from(options.body);
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
    if (body.input.at(-1)?.type !== "compaction_trigger") return normalResponse ? normalResponse({ body, signal: options.signal }) : answer();
    count++;
    return response ? await response({ body, sm, session, count }) : sse(checkpointEvents(count));
  });
  await beforeBind?.(runtime);
  await session.bindExtensions({ onError: e => errors.push(e), uiContext: {
    notify: message => notices.push(message), setStatus() {}, setWidget() {},
    theme: { fg: (_key, text) => text },
    confirm: async () => { assert.fail("internal request cancellation must not ask to pause Goal"); },
  } });
  t.after(async () => {
    try { await session.extensionRunner.emit({ type: "session_shutdown" }); assert.deepEqual(errors, []); }
    finally {
      session.dispose();
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return { session, sm, dir, codexDir, bodies, headers, urls, notices, runtime, eventBus };
}
const compactions = h => h.sm.getBranch().filter(e => e.type === "compaction");
const history = h => h.sm.getBranch().filter(e => e.type !== "custom" || e.customType !== "metisCodexCompactionFailure");

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

test("new OpenAI OAuth compacts through legacy Codex while preserving its serialized prefix and replay route", async t => {
  for (const codexAuth of ["cli", "pi"]) await t.test(codexAuth, async sub => {
    const h = await host(sub, { routeModel: responsesModel, oauth: true, codexAuth, response: () => {
      const events = checkpointEvents();
      events.at(-1).response.usage.input_tokens_details = { cached_tokens: 70 };
      return sse(events);
    } });
    assert.equal(h.runtime.isUsingOAuth("openai"), true);
    await h.session.prompt("BEFORE COMPACTION");
    const daily = h.bodies[0];
    const result = await h.session.compact("Keep the verified behavior");
    const index = h.urls.findIndex(url => url.startsWith("https://chatgpt.com/"));
    const compact = h.bodies[index];
    assert.equal(h.urls[index], "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(h.headers[index].get("authorization"), `Bearer ${FAKE_API_KEY}`);
    assert.equal(h.headers[0].get("authorization"), `Bearer ${newOAuthKey}`);
    assert.equal(h.headers[index].get("x-codex-beta-features"), "remote_compaction_v2");
    for (const field of ["prompt_cache_key", "tools", "text", "parallel_tool_calls"]) {
      assert.deepEqual(compact[field], daily[field], field);
    }
    assert.deepEqual(compact.input[0], daily.input[0]);
    assert.equal(compact.instructions, "");
    assert.equal(compact.input.at(-1).type, "compaction_trigger");
    assert.match(JSON.stringify(compact.input.at(-2)), /Keep the verified behavior/);
    assert.equal(result.usage.cacheRead, 70);
    assert.ok(!h.urls.some(url => url.endsWith("/compact")));
    assert.ok(compactions(h).at(-1).details[key].codexBinding);
    await h.session.prompt("CONTINUE");
    assert.equal(h.urls.at(-1), "https://api.openai.com/v1/responses");
    assert.equal(h.headers.at(-1).get("authorization"), `Bearer ${newOAuthKey}`);
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
    assert.ok(!JSON.stringify(compactions(h)).includes(newOAuthKey));
    assert.ok(!JSON.stringify(compactions(h)).includes(FAKE_API_KEY));
  });
});

test("hybrid checkpoints survive reload and recompact without replaying another Codex account's state", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  const next = await host(t, { routeModel: responsesModel, oauth: true, existing: h.sm.getSessionFile() });
  await next.session.prompt("AFTER RELOAD");
  assert.equal(next.urls[0], "https://api.openai.com/v1/responses");
  assert.equal(next.bodies[0].input.filter(item => item.type === "compaction").length, 1);
  await next.session.compact();
  const repeated = next.bodies[next.urls.findIndex(url => url.startsWith("https://chatgpt.com/"))];
  assert.equal(repeated.input.filter(item => item.type === "compaction").length, 1);
  writeCodexLogin(next.codexDir, "different-codex-account");
  await next.session.prompt("WORK AFTER PRODUCER CHANGE");
  await next.session.compact();
  const rebuilt = next.bodies.at(-1);
  assert.equal(rebuilt.input.some(item => item.type === "compaction"), false);
  assert.match(JSON.stringify(rebuilt.input), /OK/);
  assert.doesNotMatch(JSON.stringify(rebuilt.input), /old work/);
  rmSync(join(next.codexDir, "auth.json"));
  await next.session.prompt("CONTINUE WITHOUT PRODUCER LOGIN");
  assert.equal(next.urls.at(-1), "https://api.openai.com/v1/responses");
  assert.equal(next.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("existing token-bound checkpoints remain usable under the exact original credential", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  compactions(h).at(-1).details[key].binding = createHash("sha256").update(JSON.stringify([
    responsesModel.provider, responsesModel.api, responsesModel.id, responsesModel.baseUrl, newOAuthKey, undefined,
  ])).digest("hex");
  await h.session.prompt("RESUME EXISTING CHECKPOINT");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  await h.session.compact();
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("native OAuth refresh preserves checkpoint identity through ciphertext rotation and reload", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  h.runtime.registerProvider("openai", { baseUrl: responsesModel.baseUrl });
  await h.runtime.refresh({ allowNetwork: false });
  const fetch = globalThis.fetch;
  const access = "x." + Buffer.from(JSON.stringify({ client_id: "dynamic_agent_client", jti: "refreshed-token",
    "https://api.openai.com/auth": { per_user_salt: "offline", encrypted_auth_metadata: "rotated-ciphertext" },
  })).toString("base64url") + ".x";
  let refreshed = 0;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (String(url).includes("/oauth/token")) {
      refreshed++;
      return Promise.resolve(Response.json({ access_token: access, refresh_token: "rotated-refresh",
        expires_in: 3600, scope: "chatgpt.tokens.use.direct offline_access" }));
    }
    return fetch(url, options);
  });
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  t.mock.method(Date, "now", () => auth.openai.expires + 1);
  await h.session.prompt("AFTER REFRESH");
  assert.equal(refreshed, 1);
  assert.equal(h.headers.at(-1).get("authorization"), `Bearer ${access}`);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  const saved = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8")).openai;
  const next = await host(t, { routeModel: responsesModel, oauth: true, existing: h.sm.getSessionFile(), credential: saved });
  await next.session.prompt("AFTER REFRESH AND RELOAD");
  assert.equal(next.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  await next.session.compact();
  assert.equal(next.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

async function rotateOAuth(t, h, catalog = false, generation = 0) {
  const fetch = globalThis.fetch;
  const access = "x." + Buffer.from(JSON.stringify({ client_id: "dynamic_agent_client", jti: `rotation-${generation}`,
    "https://api.openai.com/auth": { per_user_salt: "offline", encrypted_auth_metadata: "rotated-grant" },
  })).toString("base64url") + ".x";
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (String(url).includes("/oauth/token")) return Promise.resolve(Response.json({
      access_token: access, refresh_token: "rotated-refresh", expires_in: 3600,
      scope: "chatgpt.tokens.use.direct offline_access",
    }));
    if (!String(url).includes("/responses")) return Promise.resolve(new Response("offline catalog", { status: 404 }));
    return fetch(url, options);
  });
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  t.mock.method(Date, "now", () => auth.openai.expires + 1);
  if (catalog) await h.runtime.refresh({ providers: ["openai"], allowNetwork: true });
  else await h.session.prompt("AFTER TRACKED ROTATION");
  return JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8")).openai;
}

test("catalog recomposition preserves OAuth checkpoint continuity and provider configuration", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, async beforeBind(runtime) {
    runtime.registerProvider("openai", { baseUrl: responsesModel.baseUrl, headers: { "x-checkpoint-tenant": "kept" } });
    await runtime.refresh({ allowNetwork: false });
  } });
  await h.session.compact();
  const saved = await rotateOAuth(t, h, true);
  assert.ok(saved.metisCodexCheckpointIdentity, "the native catalog refresh persists grant continuity");
  await h.session.prompt("AFTER CATALOG ROTATION");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.equal(h.headers.at(-1).get("x-checkpoint-tenant"), "kept");
  await h.session.reload();
  await h.session.prompt("AFTER RELOAD OF CATALOG ROTATION");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("catalog wrapper recomposition during compaction does not discard an unchanged provider result", async t => {
  const h = await host(t, { response: async ({ session }) => {
    await session.modelRuntime.refresh({ allowNetwork: false });
    return sse(checkpointEvents());
  } });
  await h.session.compact();
  assert.equal(compactions(h).length, 1);
});

test("durable OAuth registration preserves native login prompts and cancellation", async t => {
  const promptSignal = new AbortController().signal;
  const h = await host(t, { routeModel: responsesModel, oauth: true, beforeBind(runtime) {
    t.mock.method(runtime.getProvider("openai").auth.oauth, "login", async interaction => {
      interaction.notify({ type: "auth_url", url: "https://offline.invalid/login", instructions: "offline" });
      assert.equal(await interaction.prompt({ type: "manual_code", message: "code", signal: promptSignal }), "offline-code");
      return { type: "oauth", access: newOAuthKey, refresh: "offline-login", clientId: "dynamic_agent_client", expires: Date.now() + 3600000 };
    });
  } });
  const notifications = [];
  await h.runtime.login("openai", "oauth", {
    signal: new AbortController().signal, notify: event => notifications.push(event),
    prompt: async prompt => { assert.equal(prompt.type, "manual_code"); assert.equal(prompt.signal, promptSignal); return "offline-code"; },
  });
  assert.equal(notifications[0].type, "auth_url");
});

test("OAuth continuity survives provider display-name changes", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, beforeBind(runtime) {
    runtime.getProvider("openai").auth.oauth.name = "ChatGPT subscription (renamed)";
  } });
  await h.session.compact();
  const saved = await rotateOAuth(t, h, true);
  assert.ok(saved.metisCodexCheckpointIdentity);
  await h.session.prompt("AFTER PROVIDER DISPLAY-NAME CHANGE");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("OAuth bookkeeping failures cannot prevent credential refresh", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, async beforeBind(runtime) {
    const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
    const native = openaiProvider();
    const toAuth = native.auth.oauth.toAuth;
    t.mock.method(native.auth.oauth, "toAuth", credential => {
      if (credential.expires <= Date.now()) throw new Error("old credential cannot be resolved");
      return toAuth(credential);
    });
    runtime.registerNativeProvider(native);
    await runtime.refresh({ allowNetwork: false });
  } });
  await h.session.compact();
  const saved = await rotateOAuth(t, h);
  assert.equal(saved.refresh, "rotated-refresh", "bookkeeping cannot block the original refresh");
  assert.ok(saved.metisCodexCheckpointIdentity);
  await h.session.prompt("AFTER BOOKKEEPING FAILURE");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("cancelled checkpoint requests clear payload even when abort is ineffective", async t => {
  for (const oversized of [false, true]) await t.test(oversized ? "oversized restoration" : "unverified checkpoint", async t => {
    const h = await host(t, { routeModel: responsesModel, oauth: true });
    await h.session.compact();
    if (oversized) {
      h.sm.appendContextEdit(h.sm.getBranch().find(e => e.type === "message").id,
        { content: "DO NOT SEND RESTORED HISTORY ".repeat(5000) });
      await h.session.setModel({ ...responsesModel, contextWindow: 8000, maxTokens: 1024 });
    } else {
      const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
      auth.openai.access = `${newOAuthKey}unproven`;
      writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
    }
    t.mock.method(h.session.agent, "abort", () => {});
    let cancellations = 0;
    h.eventBus.on(METIS_EVENTS.checkpointRequestCancelled, () => cancellations++);
    await h.session.prompt("MUST NOT SEND CONVERSATION");
    assert.deepEqual(h.bodies.at(-1).input, []);
    assert.equal(cancellations, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(compactions(h).length, 1);
  });
});

test("a missing native checkpoint carrier cancels instead of losing compressed context", async t => {
  const h = await host(t);
  await h.session.compact();
  const provider = h.runtime.getProvider(model.provider), stream = provider.streamSimple.bind(provider);
  t.mock.method(provider, "streamSimple", (m, context, options) => stream(m, context, {
    ...options, onPayload: payload => options.onPayload({ ...payload, input: [] }),
  }));
  const calls = h.bodies.length;
  await h.session.prompt("CARRIER MUST REMAIN PRESENT");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /carrier changed/);
  assert.equal(compactions(h).length, 1);
});

test("legacy checkpoint materializes a portable summary on a proven model change", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  h.sm.appendModelChange(responsesModel.provider, responsesModel.id);
  await h.session.compact();
  delete compactions(h).at(-1).details[key].scope;
  delete compactions(h).at(-1).details[key].model;
  await h.session.setModel({ ...responsesModel, id: "gpt-6-sol" });
  const calls = h.bodies.length;
  await h.session.prompt("RESTORE ON PROVEN MODEL CHANGE");
  assert.equal(h.bodies.length, calls + 2);
  assert.equal(h.bodies.at(-2).model, responsesModel.id);
  assert.equal(h.bodies.at(-2).input.filter(item => item.type === "compaction").length, 1);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /ORIGINAL USER|old work/);
  assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
});

test("credential kind changes pause ordinary replay without expanding history", async t => {
  for (const mode of ["api-to-oauth", "oauth-to-api", "same-token-oauth-to-api"]) await t.test(mode, async t => {
    const oauth = mode !== "api-to-oauth";
    const h = await host(t, { routeModel: responsesModel, oauth });
    if (!oauth) writeCodexLogin(h.codexDir);
    await h.session.compact();
    const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
    auth.openai = oauth ? { type: "api_key", key: mode === "same-token-oauth-to-api" ? newOAuthKey : "sk-offline-new-key" }
      : { type: "oauth", access: newOAuthKey, refresh: "offline-new-login", clientId: "dynamic_agent_client", expires: Date.now() + 3600000 };
    writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
    await h.runtime.refresh({ allowNetwork: false });
    const calls = h.bodies.length;
    await h.session.prompt("RECOVER UNDER NEW CREDENTIAL KIND");
    assert.equal(h.bodies.length, calls);
    assert.match(h.notices.join("\n"), /identity.*verified/);
    await h.session.compact();
    assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false,
      "recompaction rebuilds instead of reusing the old credential kind's checkpoint");
  });
});

test("credential kind changes during compaction prevent publication even with the same token", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, async response({ session }) {
    writeFileSync(join(h.dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: newOAuthKey } }));
    await session.modelRuntime.refresh({ allowNetwork: false });
    return sse(checkpointEvents());
  } });
  await assert.rejects(h.session.compact(), /cancel/i);
  assert.equal(compactions(h).length, 0);
  assert.match(h.notices.join("\n"), /source changed/);
});

test("API key rotation pauses replay instead of expanding the checkpoint", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: false });
  await h.session.compact();
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-offline-rotated" } }));
  const calls = h.bodies.length;
  await h.session.prompt("AFTER API KEY ROTATION");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /identity.*verified/);
});

test("unverified oversized checkpoints provide a usable recovery branch without losing source", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, condense: true });
  const recoveryPoint = h.sm.getBranch().find(e => e.type === "message" && e.message.role === "assistant").id;
  h.sm.appendMessage(user("OVERSIZED SOURCE ".repeat(8000)));
  h.sm.appendMessage(assistant("Work following the oversized source."));
  h.sm.appendMessage(user("KEPT AFTER OVERSIZED SOURCE"));
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, contextWindow: 8000, maxTokens: 1024 });
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  auth.openai.access = `${newOAuthKey}untracked-oversized`;
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
  const calls = h.bodies.length;
  await h.session.prompt("CANNOT REPLAY UNVERIFIED CHECKPOINT");
  await assert.rejects(h.session.compact(), /cancel/i);
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /\/tree.*resume before the oversized input/);
  await h.session.navigateTree(recoveryPoint, { summarize: false });
  await h.session.prompt("CONTINUE ON THE RECOVERY BRANCH");
  assert.equal(h.bodies.length, calls + 1);
  assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
  assert.ok(h.sm.getEntries().some(e => e.type === "message" && e.message.content?.startsWith?.("OVERSIZED SOURCE")),
    "the original oversized branch is retained in the session ledger");
});

test("registered native OAuth keeps its source methods through configured overlays", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true,
    modelsConfig: { providers: { openai: { headers: { "x-native-tenant": "retained" } } } },
    async beforeBind(runtime) {
      const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
      runtime.registerNativeProvider(openaiProvider());
      await runtime.refresh({ allowNetwork: false });
    },
  });
  await h.session.compact();
  await rotateOAuth(t, h, true);
  await h.session.prompt("NATIVE SOURCE AFTER RECOMPOSITION");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.equal(h.headers.at(-1).get("x-native-tenant"), "retained");
});

test("legacy token-bound checkpoint survives its first observed refresh", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  const checkpoint = compactions(h).at(-1).details[key];
  checkpoint.binding = createHash("sha256").update(JSON.stringify([
    responsesModel.provider, responsesModel.api, responsesModel.id, responsesModel.baseUrl, newOAuthKey, undefined,
  ])).digest("hex");
  delete checkpoint.scope;
  await rotateOAuth(t, h);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  const before = h.bodies.length;
  await h.session.setModel({ ...responsesModel, id: "gpt-6-sol" });
  await h.session.prompt("DO NOT PORT A LEGACY CHECKPOINT TO ANOTHER MODEL");
  assert.equal(h.bodies.length, before, "refresh aliases are scoped to their original model and route");
});

test("legacy refresh proof includes models added after continuity tracking starts", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  const extra = { ...responsesModel, id: "fresh-catalog-model", name: "Fresh catalog model" };
  h.runtime.registerProvider("openai", { models: [extra] });
  await h.runtime.refresh({ allowNetwork: false });
  await h.session.setModel(extra);
  await h.session.compact();
  const checkpoint = compactions(h).at(-1).details[key];
  checkpoint.binding = createHash("sha256").update(JSON.stringify([
    extra.provider, extra.api, extra.id, extra.baseUrl, newOAuthKey, undefined,
  ])).digest("hex");
  delete checkpoint.scope;
  await rotateOAuth(t, h);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("bounded refresh proofs retain both original and recent legacy checkpoints", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  const extras = Array.from({ length: 64 }, (_, index) => ({ ...responsesModel, id: `proof-model-${index}` }));
  h.runtime.registerProvider("openai", { models: extras });
  await h.runtime.refresh({ allowNetwork: false });
  await h.session.compact();
  const checkpoint = compactions(h).at(-1).details[key];
  const tokenBinding = access => createHash("sha256").update(JSON.stringify([
    responsesModel.provider, responsesModel.api, responsesModel.id, responsesModel.baseUrl, access, undefined,
  ])).digest("hex");
  checkpoint.binding = tokenBinding(newOAuthKey);
  delete checkpoint.scope;
  await rotateOAuth(t, h, false, 1);
  const second = await rotateOAuth(t, h, false, 2);
  const third = await rotateOAuth(t, h, false, 3);
  assert.equal(third.metisCodexCheckpointLegacyBindings.length, 128);
  assert.ok(third.metisCodexCheckpointLegacyBindings.some(entry => entry.binding === checkpoint.binding));
  checkpoint.binding = tokenBinding(second.access);
  await h.session.prompt("REPLAY RECENT TOKEN-BOUND CHECKPOINT");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("transient checkpoint authentication failure keeps compressed history and reports its cause", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  h.sm.appendContextEdit(source.id, { content: "BIG AUTH HISTORY ".repeat(8000) });
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, contextWindow: 8000, maxTokens: 1024 });
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  let unavailable = true;
  t.mock.method(h.runtime, "getAuth", async (...args) => {
    if (unavailable) throw new Error("OFFLINE temporary OAuth refresh failure; Bearer secret-value");
    return getAuth(...args);
  });
  const before = h.bodies.length, checkpoint = compactions(h).at(-1);
  await h.session.prompt("AUTH TEMPORARILY UNAVAILABLE");
  assert.equal(h.bodies.length, before, "no inference or restored-history request is sent");
  assert.equal(compactions(h).at(-1), checkpoint);
  assert.match(h.notices.join("\n"), /temporary OAuth refresh failure/);
  assert.doesNotMatch(h.notices.join("\n"), /secret-value|Restored history needs/);
  unavailable = false;
  await h.session.prompt("RETRY AFTER AUTH RECOVERS");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("an unknown grant stops ordinary replay and manual compact safely rebuilds its input", async t => {
  const small = { ...responsesModel, contextWindow: 20000, maxTokens: 16000 };
  const h = await host(t, { routeModel: small, oauth: true });
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  h.sm.appendContextEdit(source.id, { content: "REBUILD SOURCE ".repeat(4000) });
  await h.session.compact();
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  auth.openai.access = `${newOAuthKey}untracked-rotation`;
  delete auth.openai.metisCodexCheckpointIdentity;
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
  const before = h.bodies.length;
  await h.session.prompt("UNVERIFIED GRANT");
  assert.equal(h.bodies.length, before);
  assert.match(h.notices.join("\n"), /verif|identity/i);
  assert.doesNotMatch(h.notices.join("\n"), /Restored history needs/);
  await h.session.compact();
  assert.equal(compactions(h).length, 2);
  const rebuilt = h.bodies.at(-1);
  assert.equal(rebuilt.input.some(item => item.type === "compaction"), false, "old opaque checkpoint is never rebound");
  assert.match(JSON.stringify(rebuilt), /REBUILD SOURCE/);
  await h.session.prompt("USE NEW CHECKPOINT");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
});

test("large history does not expand on retry after an unrelated tail race", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  h.sm.appendContextEdit(source.id, { content: "OLD TAIL RACE HISTORY ".repeat(8000) });
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, contextWindow: 8000, maxTokens: 1024 });
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  let appended = false;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (options?.signal && !appended) { appended = true; h.sm.appendMessage(user("TAIL ARRIVED AFTER PREPARATION")); }
    return result;
  });
  const before = h.bodies.length;
  await h.session.prompt("RACE THIS REQUEST");
  assert.equal(h.bodies.length, before);
  await h.session.prompt("RETRY WITHOUT EXPANDING OLD HISTORY");
  assert.equal(h.bodies.length, before + 1);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /TAIL ARRIVED AFTER PREPARATION/);
  assert.doesNotMatch(h.notices.join("\n"), /Restored history needs/);
});

function appendRecoverableResult(h) {
  const text = "RECOVERABLE_TOOL_OUTPUT_".repeat(5000);
  const call = { id: "recovery-call", name: "read", arguments: { path: "/tmp/archived-source" } };
  h.sm.appendMessage({ ...assistant(""), timestamp: 1, content: [{ type: "toolCall", ...call }] });
  h.sm.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text }], isError: false, timestamp: 3 });
  h.sm.appendMessage(assistant("Recovered work is archived."));
  h.sm.appendMessage(user("KEPT RECOVERY TAIL"));
  return { text, call };
}
async function publishRecoverySummary(h, source) {
  h.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: source.call.id, toolName: source.call.name,
    args: source.call.arguments, resultText: source.text, isError: false, timestamp: 3, resultTimestamp: 3, turnIndex: 1 }] });
  h.sm.appendCustomMessageEntry("context-prune-summary", "DURABLE RECOVERY SUMMARY", false,
    { toolCallIds: [source.call.id], toolCallRefs: [{ toolCallId: source.call.id, resultTimestamp: 3 }] });
  await h.session.reload();
}

test("initial and reusable remote compaction use durable Condense projection before budgeting", async t => {
  for (const [name, options] of [
    ["Codex", { routeModel: model }],
    ["hybrid OAuth", { routeModel: responsesModel, oauth: true }],
    ["Responses API key", { routeModel: responsesModel, oauth: false }],
  ]) for (const reusable of [false, true]) await t.test(`${name}: ${reusable ? "reusable" : "initial"}`, async sub => {
    const h = await host(sub, { ...options, condense: true });
    if (reusable) await h.session.compact();
    const source = appendRecoverableResult(h);
    await publishRecoverySummary(h, source);
    // Put both the archived result and its summary inside the discarded prefix,
    // rather than testing evidence that will survive verbatim in the kept tail.
    h.sm.appendMessage(assistant("Work after the durable summary."));
    h.sm.appendMessage(user("RETAINED EXCHANGE"));
    await h.session.setModel({ ...options.routeModel, contextWindow: 8000, maxTokens: 1024 });
    const before = h.bodies.length;
    await h.session.compact();
    assert.equal(h.bodies.length, before + 1, "projection must reuse durable evidence without a summary request");
    const body = JSON.stringify(h.bodies.at(-1));
    assert.doesNotMatch(body, /RECOVERABLE_TOOL_OUTPUT_/);
    assert.match(body, /DURABLE RECOVERY SUMMARY/);
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, reusable ? 1 : 0);
    assert.equal(compactions(h).length, reusable ? 2 : 1);
    assert.ok(h.sm.getBranch().some(entry => entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.content.some(part => part.text === source.text)), "projection never overwrites original evidence");
  });
});

test("unprojectable initial and reusable compaction input is rejected locally without losing history", async t => {
  for (const reusable of [false, true]) await t.test(reusable ? "reusable" : "initial", async sub => {
    const h = await host(sub, { routeModel: responsesModel, oauth: true });
    if (reusable) await h.session.compact();
    h.sm.appendMessage(user("UNPROJECTABLE LARGE INPUT ".repeat(3000)));
    h.sm.appendMessage(assistant("completed oversized exchange"));
    h.sm.appendMessage(user("KEEP THIS RECENT TAIL"));
    await h.session.setModel({ ...responsesModel, contextWindow: 8000, maxTokens: 1024 });
    const before = h.bodies.length, original = history(h).map(entry => entry.id);
    await assert.rejects(h.session.compact(), /cancel/i);
    assert.equal(h.bodies.length, before, "an oversized visible prefix must not reach either remote endpoint");
    assert.deepEqual(history(h).map(entry => entry.id), original);
    assert.equal(compactions(h).length, reusable ? 1 : 0);
    assert.match(h.notices.join("\n"), /approximately.*8000|context window is 8000/);
    const failure = h.sm.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "metisCodexCompactionFailure").data;
    assert.ok(failure.projectedInputTokensEstimate > 8000);
    assert.equal(failure.inputWindow, 8000);
    assert.equal(failure.outputReserve, 0, "remote compaction does not reserve ordinary generation output");
    assert.equal(failure.hasOpaqueCheckpoint, reusable);
  });
});

test("remote input budgeting includes compaction focus without ordinary output reservation", async t => {
  const h = await host(t, { routeModel: { ...model, contextWindow: 2000, maxTokens: 16000 } });
  await assert.rejects(h.session.compact("FOCUS ".repeat(2000)), /cancel/i);
  assert.equal(h.bodies.length, 0, "custom instructions are part of the input window");
  await h.session.compact("Keep the goal");
  assert.equal(h.bodies.length, 1, "small input fits even when ordinary maxTokens exceeds the input window");
  assert.equal(compactions(h).length, 1);
});

test("portable context retains real Condense summaries without restoring source", async t => {
  const h = await host(t, { condense: true });
  const source = appendRecoverableResult(h);
  await h.session.compact();
  await publishRecoverySummary(h, source);
  await h.session.setModel({ ...modelNamed("gpt-6-sol"), contextWindow: 12000, maxTokens: 1024 });
  const before = h.bodies.length;
  await h.session.prompt("RECOVER THROUGH CONDENSE");
  assert.equal(h.bodies.length, before + 2);
  const body = JSON.stringify(h.bodies.at(-1));
  assert.doesNotMatch(body, /RECOVERABLE_TOOL_OUTPUT_/);
  assert.match(body, /DURABLE RECOVERY SUMMARY/);
  assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
  assert.doesNotMatch(h.notices.join("\n"), /Restored history needs/);
});

test("manual checkpoint rebuild includes durable summaries beyond the kept boundary", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true, condense: true });
  const source = appendRecoverableResult(h);
  await h.session.compact();
  await publishRecoverySummary(h, source);
  h.sm.appendMessage(assistant("WORK BEFORE RETAINED EXCHANGE ".repeat(300)));
  const future = { call: { id: "retained-call", name: "read", arguments: {} }, text: "RETAINED TAIL OUTPUT" };
  h.sm.appendMessage({ ...assistant(""), timestamp: 9, content: [{ type: "toolCall", ...future.call }] });
  h.sm.appendMessage({ role: "toolResult", toolCallId: future.call.id, toolName: future.call.name,
    content: [{ type: "text", text: future.text }], isError: false, timestamp: 10 });
  h.sm.appendCustomEntry("context-prune-index", { toolCalls: [{ toolCallId: future.call.id, toolName: future.call.name,
    args: {}, resultText: future.text, isError: false, timestamp: 10, resultTimestamp: 10, turnIndex: 2 }] });
  h.sm.appendCustomMessageEntry("context-prune-summary", "FUTURE TAIL SUMMARY", false,
    { toolCallRefs: [{ toolCallId: future.call.id, resultTimestamp: 10 }] });
  await h.session.reload();
  // Keep the complete future tool exchange out of the discarded prefix.
  h.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 100 } });
  await h.session.setModel({ ...responsesModel, contextWindow: 12000, maxTokens: 1024 });
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  auth.openai.access = `${newOAuthKey}untracked-rebuild`;
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
  const before = h.bodies.length;
  await h.session.compact();
  assert.equal(h.bodies.length, before + 1);
  const body = h.bodies.at(-1);
  assert.match(JSON.stringify(body), /DURABLE RECOVERY SUMMARY/);
  assert.doesNotMatch(JSON.stringify(body), /RECOVERABLE_TOOL_OUTPUT_/);
  assert.doesNotMatch(JSON.stringify(body), /FUTURE TAIL SUMMARY/);
  assert.equal(body.input.some(item => item.type === "compaction"), false);
  assert.equal(compactions(h).length, 2);
});

test("an unproven OAuth replacement preserves the checkpoint and stops replay despite matching opaque user metadata", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  const auth = JSON.parse(readFileSync(join(h.dir, "auth.json"), "utf8"));
  auth.openai = { type: "oauth", access: `${newOAuthKey}replacement`, refresh: "new-login", expires: Date.now() + 3_600_000 };
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify(auth));
  const before = h.bodies.length;
  await h.session.prompt("NEW LOGIN");
  assert.equal(h.bodies.length, before, "neither another grant's checkpoint nor expanded originals are sent");
  assert.equal(compactions(h).length, 1);
  assert.match(h.notices.join("\n"), /identity.*verif/i);
});

test("oversized source stays compressed across model switches and recompaction", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  h.sm.appendContextEdit(h.sm.getBranch().find(e => e.type === "message").id, { content: "RAW HISTORY ".repeat(8000) });
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, id: "gpt-6-sol", contextWindow: 8000, maxTokens: 1024 });
  const calls = h.bodies.length;
  await h.session.prompt("RESTORE TOO MUCH HISTORY");
  assert.equal(h.bodies.length, calls + 2, "summarize the checkpoint once, then send compact text");
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /RAW HISTORY|Metis Codex remote checkpoint/);
  await h.session.compact();
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /RAW HISTORY|Metis Codex remote checkpoint/);
  assert.equal(compactions(h).length, 2);
  assert.ok(h.sm.getBranch().some(e => e.type === "context_edit" && e.replacement.content.startsWith("RAW HISTORY")));
});

test("compaction failures retain sanitized HTTP and stream diagnostics outside model context", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true,
    response: () => Response.json({ error: { code: "context_length_exceeded",
      message: `input too large; Bearer ${newOAuthKey}; request ID req-offline-400` } },
    { status: 400, headers: { "x-request-id": "req-offline-400" } }),
  });
  await assert.rejects(h.session.compact(), /cancel/i);
  const entry = h.sm.getBranch().findLast(e => e.type === "custom" && e.customType === "metisCodexCompactionFailure");
  assert.ok(entry, "failed compactions leave inspectable diagnostics");
  assert.equal(entry.data.status, 400);
  assert.equal(entry.data.requestId, "req-offline-400");
  assert.match(entry.data.message, /context_length_exceeded|input too large/);
  assert.ok(!JSON.stringify(entry.data).includes(newOAuthKey));
  assert.match(h.notices.join("\n"), /400|context_length_exceeded|input too large/);
  assert.doesNotMatch(h.notices.join("\n"), /Check authentication\/permissions/);
  await h.session.prompt("CONTINUE AFTER FAILURE");
  assert.ok(!JSON.stringify(h.bodies.at(-1)).includes("req-offline-400"));
});

test("hybrid compaction cancels without legacy OAuth or when its producer changes before publication", async t => {
  for (const kind of ["missing", "api-key", "changed"]) await t.test(kind, async sub => {
    const h = await host(sub, { routeModel: responsesModel, oauth: true, codexAuth: kind === "changed" ? "cli" : "missing",
      response: ({ count }) => {
        writeCodexLogin(h.codexDir, "changed-before-publication");
        return sse(checkpointEvents(count));
      },
    });
    if (kind === "api-key") writeFileSync(join(h.codexDir, "auth.json"), JSON.stringify({
      auth_mode: "apikey", OPENAI_API_KEY: "sk-offline", tokens: { access_token: FAKE_API_KEY },
    }));
    const source = JSON.stringify(history(h));
    await assert.rejects(h.session.compact(), /cancel/i);
    assert.equal(JSON.stringify(history(h)), source);
    assert.equal(compactions(h).length, 0);
    assert.equal(h.bodies.length, kind === "changed" ? 1 : 0);
    assert.match(h.notices.join("\n"), kind === "changed" ? /Compaction source changed/ : /codex login/);
  });
});

test("hybrid automatic recovery keeps Codex retries and preserves history on transport failure", async t => {
  for (const reason of ["automatic", "overflow"]) await t.test(reason, async sub => {
    let ordinary = 0;
    const h = await host(sub, { routeModel: responsesModel, oauth: true, condense: true, auto: reason === "automatic",
      normalResponse() {
        if (++ordinary === 1 && reason === "overflow") return Response.json({
          error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model." },
        }, { status: 400 });
        return answer();
      },
      response: ({ count }) => count < 3
      ? Response.json({ error: { message: "temporary overload" } }, { status: 429, headers: { "retry-after": "0" } })
      : sse(checkpointEvents(count)),
    });
    await h.session.prompt("CONTINUE AFTER CAPACITY RECOVERY");
    assert.equal(h.urls.filter(url => url === "https://chatgpt.com/backend-api/codex/responses").length, 3);
    assert.equal(compactions(h).length, 1);
    assert.equal(h.urls.at(-1), "https://api.openai.com/v1/responses");
    assert.ok(h.bodies.at(-1).input.some(item => item.type === "compaction"));
  });
  const h = await host(t, { routeModel: responsesModel, oauth: true,
    response: () => Response.json({ error: { message: "unauthorized" } }, { status: 401 }),
  });
  const source = JSON.stringify(history(h));
  await assert.rejects(h.session.compact(), /cancel/i);
  assert.equal(JSON.stringify(history(h)), source);
  assert.equal(h.bodies.length, 3);
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
    const failure = h.sm.getBranch().findLast(e => e.type === "custom" && e.customType === "metisCodexCompactionFailure").data;
    assert.equal(failure.inputPrepared, true);
    assert.equal(failure.checkpointCount, kind === "missing" ? 0 : kind === "duplicate" ? 2 : 1);
    assert.equal(failure.failed, kind === "duplicate" || kind === "incomplete");
  });
});

test("editing covered source requires explicit repair without expanding ordinary requests", async t => {
  const h = await host(t);
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  await h.session.compact();
  h.sm.appendContextEdit(source.id, { content: "CORRECTED ORIGINAL" });
  const calls = h.bodies.length;
  await h.session.prompt("CONTINUE AFTER EDIT");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /edited|invalid/);
  await h.session.compact();
  const body = h.bodies.at(-1);
  assert.ok(JSON.stringify(body.input).includes("CORRECTED ORIGINAL"));
  assert.equal(JSON.stringify(body.input).includes("ORIGINAL USER"), false);
  assert.equal(body.input.some(i => i.type === "compaction"), false);
  assert.equal(JSON.stringify(body.input).includes("Metis Codex remote checkpoint"), false);
});

test("model changes persist portable summaries and switching back preserves encrypted replay", async t => {
  for (const [name, routeModel, oauth] of [["Codex", model, true], ["OAuth Responses", responsesModel, true],
    ["API Responses", responsesModel, false]]) await t.test(name, async t => {
    const h = await host(t, { routeModel, oauth });
    await h.session.compact();
    await h.session.setModel({ ...routeModel, id: "gpt-6-sol" });
    const calls = h.bodies.length;
    await h.session.prompt("CHANGED MODEL");
    assert.equal(h.bodies.length, calls + 2, "one original-model summary and one target-model inference");
    assert.equal(h.bodies.at(-2).model, routeModel.id);
    assert.equal(h.bodies.at(-2).input.filter(item => item.type === "compaction").length, 1);
    const body = h.bodies.at(-1);
    assert.equal(body.input.some(i => i.type === "compaction"), false);
    assert.match(JSON.stringify(body), /OK/);
    assert.doesNotMatch(JSON.stringify(body), /old work|Metis Codex remote checkpoint/);
    assert.equal(h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metisCodexPortableSummary").length, 1);
    await h.session.setModel(routeModel);
    await h.session.prompt("ORIGINAL MODEL AGAIN");
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
    await h.session.setModel({ ...routeModel, id: "gpt-6-sol" });
    const after = h.bodies.length;
    await h.session.prompt("REUSE PORTABLE SUMMARY");
    assert.equal(h.bodies.length, after + 1);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
  });
});

test("portable summaries survive reload and branch navigation without resurrecting source", async t => {
  const h = await host(t);
  await h.session.compact();
  const checkpoint = compactions(h).at(-1);
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("CREATE PORTABLE SUMMARY");
  const path = h.sm.getSessionFile();
  const restored = await host(t, { existing: path, routeModel: modelNamed("gpt-6-sol") });
  await restored.session.prompt("CONTINUE AFTER RELOAD");
  assert.equal(restored.bodies.length, 1, "reloading reuses the persisted portable summary");
  assert.doesNotMatch(JSON.stringify(restored.bodies[0]), /old work|Metis Codex remote checkpoint/);
  await restored.session.navigateTree(checkpoint.id, { summarize: false });
  const calls = restored.bodies.length;
  await restored.session.prompt("FORK BEFORE PORTABLE SUMMARY");
  assert.equal(restored.bodies.length, calls + 2, "another branch materializes its own summary");
  assert.doesNotMatch(JSON.stringify(restored.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
});

test("later context projections cannot replace portable text with the native marker", async t => {
  const h = await host(t, { contextJournal: true });
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("PORTABLE TEXT MUST SURVIVE OTHER PROJECTORS");
  const body = JSON.stringify(h.bodies.at(-1));
  assert.match(body, /PROJECTED DURABLE SUMMARY/);
  assert.match(body, /OK/);
  assert.doesNotMatch(body, /old work|Metis Codex remote checkpoint/);
});

test("later projections cannot silently drop the summary or resurrect raw source", async t => {
  for (const contextJournal of ["raw", "drop-summary"]) await t.test(contextJournal, async t => {
    const h = await host(t, { contextJournal });
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    const calls = h.bodies.length;
    await h.session.prompt("NO RAW OR MISSING HISTORY");
    assert.equal(h.bodies.length, calls + 1, "only encrypted-to-text materialization is allowed");
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
    assert.match(h.notices.join("\n"), /summary changed during context projection/);
    await h.session.prompt("RETRY STILL HAS THE UNSAFE PROJECTOR");
    assert.equal(h.bodies.length, calls + 1);
  });
});

test("same-model API and endpoint changes use portable context on the new route", async t => {
  for (const apiChange of [false, true]) await t.test(apiChange ? "API" : "endpoint", async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel({ ...model, baseUrl: "https://changed-route.invalid/v1",
      ...(apiChange ? { api: "openai-responses" } : {}) });
    const calls = h.bodies.length;
    await h.session.prompt("CHANGED ROUTE");
    assert.equal(h.bodies.length, calls + 2);
    assert.match(h.urls.at(-2), /chatgpt\.com/);
    assert.equal(new URL(h.urls.at(-1)).origin, "https://changed-route.invalid");
    assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
  });
});

test("an unavailable original model pauses or reuses existing portable text without expansion", async t => {
  for (const cached of [false, true]) await t.test(cached ? "cached" : "uncached", async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    if (cached) await h.session.prompt("SAVE PORTABLE TEXT");
    const find = h.runtime.getModel.bind(h.runtime);
    t.mock.method(h.runtime, "getModel", (p, id) => p === model.provider && id === model.id ? undefined : find(p, id));
    const calls = h.bodies.length;
    await h.session.prompt("ORIGINAL MODEL REMOVED");
    assert.equal(h.bodies.length, calls + Number(cached));
    if (cached) assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    else assert.match(h.notices.join("\n"), /Original checkpoint model is unavailable/);
  });
});

test("portable summary failures preserve the checkpoint and never send raw inference", async t => {
  for (const failure of ["http", "empty", "truncated", "model-change", "tail-change"]) await t.test(failure, async t => {
    let failing = true;
    const h = await host(t, { normalResponse: async () => {
      if (!failing) return answer();
      if (failure === "http") return Response.json({ error: { message: "PORTABLE FAILURE", type: "invalid_request_error" } }, { status: 400 });
      if (failure === "empty") return sse([completed([])]);
      if (failure === "truncated") return sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }]);
      if (failure === "model-change") await h.session.setModel(modelNamed("gpt-6-luna"));
      if (failure === "tail-change") h.sm.appendMessage(user("APPENDED WHILE SUMMARIZING"));
      return answer();
    } });
    await h.session.compact();
    const checkpoint = compactions(h).at(-1), calls = h.bodies.length;
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("FAILED PORTABLE MIGRATION");
    assert.ok(h.bodies.length > calls);
    for (const body of h.bodies.slice(calls)) {
      assert.equal(body.model, model.id, "only the original-model summary may retry");
      assert.equal(body.input.filter(item => item.type === "compaction").length, 1);
    }
    assert.equal(h.sm.getBranch().some(e => e.type === "custom" && e.customType === "metisCodexPortableSummary"), false);
    assert.equal(compactions(h).at(-1), checkpoint);
    assert.match(h.notices.join("\n"), /no history was expanded/);
    failing = false;
    await h.session.prompt("RETRY PORTABLE MIGRATION");
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
  });
});

test("user cancellation aborts portable generation in ordinary requests and manual compaction", async t => {
  for (const manual of [false, true]) await t.test(manual ? "manual" : "inference", { timeout: 5000 }, async t => {
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const h = await host(t, { other: true, normalResponse: ({ signal }) => {
      started();
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } });
    await h.session.compact();
    const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
    h.sm.appendMessage(user("KEPT CANCELLATION TAIL"));
    const calls = h.bodies.length;
    const task = (manual ? h.session.compact() : h.session.prompt("CANCEL PORTABLE GENERATION"))
      .then(() => undefined, error => error);
    await waiting;
    if (manual) h.session.abortCompaction();
    else await h.session.abort();
    const error = await task;
    if (manual) assert.match(error?.message ?? "", /cancel|abort/i);
    assert.equal(h.bodies.length, calls + 1);
    assert.equal(h.sm.getBranch().some(e => e.type === "custom" && e.customType === "metisCodexPortableSummary"), false);
    assert.equal(compactions(h).length, 1);
  });
});

test("portable summaries tolerate tail edits but never hide edits to covered source", async t => {
  const h = await host(t);
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  const tail = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "KEPT TAIL");
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("MIGRATE");
  h.sm.appendContextEdit(tail.id, { content: "CORRECTED TAIL" });
  let calls = h.bodies.length;
  await h.session.prompt("AFTER TAIL EDIT");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /CORRECTED TAIL/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work/);
  h.sm.appendContextEdit(source.id, { content: "EDITED COVERED SOURCE" });
  calls = h.bodies.length;
  await h.session.prompt("AFTER COVERED EDIT");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /edited|invalid/);
});

test("a saved portable summary survives loss of original credentials without exposing ciphertext", async t => {
  const h = await host(t, { other: true });
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("MIGRATE WHILE AUTHENTICATED");
  await h.runtime.removeRuntimeApiKey("openai-codex");
  writeFileSync(join(h.dir, "auth.json"), "{}");
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  const calls = h.bodies.length;
  await h.session.prompt("CACHED CROSS PROVIDER");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /OK/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|opaque-1|Metis Codex remote checkpoint/);
});

test("automatic compaction after a model switch migrates the checkpoint without raw history", async t => {
  const h = await host(t);
  h.sm.appendMessage(user("HUGE HISTORICAL INPUT ".repeat(5000)));
  h.sm.appendMessage(assistant("archived work"));
  h.sm.appendMessage(user("RECENT TAIL"));
  await h.session.compact();
  h.sm.appendMessage({ ...assistant("pressure", model.contextWindow * 2), model: "gpt-6-sol", timestamp: Date.now() + 1 });
  h.sm.appendMessage(user("RECENT AFTER PRESSURE"));
  const next = await host(t, { existing: h.sm.getSessionFile(), routeModel: {
    ...modelNamed("gpt-6-sol"), contextWindow: 12000, maxTokens: 1024,
  } });
  await next.session.prompt("AUTO COMPACT AND CONTINUE");
  assert.equal(compactions(next).length, 2);
  assert.equal(next.bodies.length, 3, "portable summary, target compaction, then target inference");
  assert.equal(next.bodies[0].model, model.id);
  assert.equal(next.bodies[1].input.at(-1).type, "compaction_trigger");
  assert.doesNotMatch(JSON.stringify(next.bodies.slice(1)), /HUGE HISTORICAL INPUT/);
});

test("automatic compaction can use saved portable text after an unproven OAuth replacement", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, id: "gpt-6-sol" });
  await h.session.prompt("SAVE PORTABLE TEXT");
  h.sm.appendMessage({ ...assistant("pressure", responsesModel.contextWindow * 2), api: responsesModel.api,
    provider: responsesModel.provider, model: responsesModel.id, timestamp: Date.now() + 1 });
  h.sm.appendMessage(user("KEPT AUTH RECOVERY TAIL"));
  const next = await host(t, { existing: h.sm.getSessionFile(), routeModel: responsesModel, oauth: true,
    credential: { type: "oauth", access: `${newOAuthKey}untracked`, refresh: "offline-refresh", expires: Date.now() + 3600000 } });
  await next.session.prompt("AUTOMATIC RECOMPACTION AFTER RELOGIN");
  assert.equal(compactions(next).length, 2);
  assert.equal(next.bodies.length, 2, "cached text needs only compaction and normal inference");
  assert.equal(next.bodies[0].input.some(item => item.type === "compaction"), false);
  assert.match(JSON.stringify(next.bodies[0]), /OK/);
  assert.doesNotMatch(JSON.stringify(next.bodies[0]), /old work/);
  assert.equal(next.bodies[1].input.filter(item => item.type === "compaction").length, 1);
});

test("invalid portable cache entries are regenerated without restoring source", async t => {
  for (const damage of ["empty", "oversized", "fingerprint", "marker", "non-text"]) await t.test(damage, async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("CREATE CACHED TEXT");
    const cached = h.sm.getBranch().find(e => e.type === "custom" && e.customType === "metisCodexPortableSummary");
    if (damage === "empty") cached.data.summary = "";
    if (damage === "oversized") cached.data.summary = "x".repeat(65537);
    if (damage === "fingerprint") cached.data.fingerprint = "invalid";
    if (damage === "marker") cached.data.summary = compactions(h).at(-1).summary;
    if (damage === "non-text") cached.data.summary = {};
    const calls = h.bodies.length;
    await h.session.prompt("REGENERATE CACHED TEXT");
    assert.equal(h.bodies.length, calls + 2);
    assert.equal(h.bodies.at(-2).input.filter(item => item.type === "compaction").length, 1);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
  });
});

test("damaged checkpoint metadata cannot expand ordinary requests", async t => {
  for (const damage of ["missing", "invalid", "invalid-model", "marker", "covered-edit"]) await t.test(damage, async t => {
    const h = await host(t);
    await h.session.compact();
    const checkpoint = compactions(h).at(-1), calls = h.bodies.length;
    if (damage === "missing") delete checkpoint.details[key];
    if (damage === "invalid") checkpoint.details[key].history = [{ type: "compaction", encrypted_content: "" }];
    if (damage === "invalid-model") checkpoint.details[key].model = 42;
    if (damage === "marker") checkpoint.summary = "DAMAGED CHECKPOINT MARKER";
    if (damage === "covered-edit") h.sm.appendContextEdit(h.sm.getBranch().find(e => e.type === "message").id, { content: "CHANGED COVERED SOURCE" });
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("NO IMPLICIT RESTORATION");
    assert.equal(h.bodies.length, calls);
    assert.match(h.notices.join("\n"), /edited|invalid/);
  });
});

test("portable payloads cancel when their prepared history becomes stale", async t => {
  const h = await host(t);
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("CACHE PORTABLE SUMMARY");
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  let changed = false;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (options?.signal && !changed) { changed = true; h.sm.appendMessage(user("NEW CANONICAL TAIL")); }
    return result;
  });
  const calls = h.bodies.length;
  await h.session.prompt("STALE PORTABLE REQUEST");
  assert.equal(h.bodies.length, calls);
  await h.session.prompt("RETRY WITH PORTABLE SUMMARY");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /NEW CANONICAL TAIL/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
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

test("an account change pauses instead of sending another account's checkpoint or raw history", async t => {
  const h = await host(t);
  await h.session.compact();
  const access = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "second-offline-account" } })).toString("base64url") + ".x";
  writeFileSync(join(h.dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "offline-refresh", expires: Date.now() + 3_600_000 } }));
  const calls = h.bodies.length;
  await h.session.prompt("NEW ACCOUNT");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /identity.*verified/);
  await h.session.compact();
  assert.equal(h.headers.at(-1).get("chatgpt-account-id"), "second-offline-account");
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction"), false);
  assert.ok(JSON.stringify(h.bodies.at(-1)).includes("old work"));
});

test("a different provider compacts a portable summary without recovering raw Codex history", async t => {
  const h = await host(t, { other: true });
  await h.session.compact();
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  h.sm.appendMessage(user("OTHER TAIL"));
  const start = h.bodies.length;
  const result = await h.session.compact();
  assert.equal(h.bodies.length, start + 2);
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction_trigger" || i.type === "compaction"), false);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work/);
  assert.match(JSON.stringify(h.bodies.at(-1)), /OK/);
  assert.equal(result.summary, "OK");
  assert.equal(compactions(h).at(-1).details?.[key], undefined);
});

test("manual compaction on another provider cannot turn summary failure into raw recovery", async t => {
  const h = await host(t, { other: true, normalResponse: () => sse([completed([])]) });
  await h.session.compact();
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  h.sm.appendMessage(user("KEPT OTHER PROVIDER TAIL"));
  const calls = h.bodies.length;
  await assert.rejects(h.session.compact(), /cancel/i);
  assert.equal(compactions(h).length, 1);
  assert.equal(h.bodies.length, calls + 1, "only the original model attempts to create portable text");
  assert.equal(h.bodies.at(-1).model, model.id);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.match(h.notices.join("\n"), /empty or invalid/);
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

for (const routeModel of [model, responsesModel]) test(`${routeModel.api}: a late covered edit cancels until explicit repair`, async t => {
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
  assert.equal(h.bodies.length, before, "retry must not unfold edited source");
  await h.session.compact();
  const body = h.bodies.at(-1);
  assert.ok(JSON.stringify(body.input).includes("EDITED WHILE AUTHENTICATING"));
  assert.equal(JSON.stringify(body.input).includes("HIDDEN GOAL UI"), false);
  assert.equal(JSON.stringify(body.input).includes("STALE GOAL CONTINUATION"), false);
  assert.equal(body.input.some(item => item.type === "compaction"), false);
  assert.equal(JSON.stringify(body).includes("Metis Codex remote checkpoint"), false);
  await h.session.prompt("CONTINUE AFTER EXPLICIT REPAIR");
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.equal(currentGoal().status, "budgetLimited", "the successful explicit retry is accounted normally");
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
  assert.equal(sockets.reduce((n, socket) => n + socket.sent.length, 0), before, "retry cannot unfold edited source either");
  await h.session.compact();
  assert.match(JSON.stringify(h.bodies.at(-1)), /EDITED AFTER WS CACHE/);
  await h.session.prompt("CONTINUE AFTER REPAIR");
  const sent = sockets.flatMap(socket => socket.sent).at(-1);
  assert.equal(sent.input.filter(item => item.type === "compaction").length, 1);
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
