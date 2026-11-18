import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import {
  createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { FAKE_API_KEY, modelNamed } from "./native-provider.mjs";

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
const usage = (input = 100) => ({
  input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const assistant = (text, input = 100) => ({
  role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
  usage: usage(input), stopReason: "stop", timestamp: Date.now(),
});
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const sse = events => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n", {
  headers: { "content-type": "text/event-stream" },
});
function completed(output, cachedTokens) {
  const usage = { input_tokens: 100, output_tokens: 2, total_tokens: 102 };
  if (cachedTokens !== undefined) usage.input_tokens_details = { cached_tokens: cachedTokens };
  return { type: "response.completed", response: { id: "r", status: "completed", output, usage } };
}
function answerEvents(cachedTokens) {
  const item = {
    type: "message", id: "msg", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "OK", annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item }, completed([item], cachedTokens),
  ];
}
const answer = cachedTokens => sse(answerEvents(cachedTokens));
function checkpointEvents(n = 1) {
  const item = { type: "compaction", id: `cmp-${n}`, encrypted_content: `opaque-${n}`, status: "completed" };
  return [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    completed([item]),
  ];
}

// The fixture binds real Pi extensions and replaces only Responses transport.
async function createCompactionHost(t, {
  auto = false, condense = false, goal = false, execution = false, contextJournal = false, providerOverride = false,
  existing, response, compactResponse, normalResponse, other = false, routeModel = model, transport = "sse",
  oauth = routeModel.api !== "openai-responses", codexAuth = "cli", credential,
  beforeBind, modelsConfig, compactionPolicy, previousTokens, compactionSettings, extensionPaths = [],
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "metis-codex-compact-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  const oldCodexHome = process.env.CODEX_HOME;
  const errors = [];
  let session;
  t.after(async () => {
    try {
      try { await session?.extensionRunner.emit({ type: "session_shutdown" }); }
      finally { session?.dispose(); }
      assert.deepEqual(errors, []);
    } finally {
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
    sm.appendMessage(assistant("more work ".repeat(100), previousTokens ?? (auto ? model.contextWindow - 10 : 100)));
    sm.appendMessage(user("KEPT TAIL"));
  }
  if (goal) sm.appendCustomEntry("goal", { version: 2, action: "create", goal: {
    id: "checkpoint-goal", objective: "preserve the active goal during context recovery", status: "active", tokenBudget: 1, tokensUsed: 0,
  } });
  writeFileSync(join(dir, "metis-pi.toml"), `[contextPrune]
enabled = true
opportunisticCompaction = true
[contextPrune.chainCompression]
enabled = false
[contextPrune.purgeErrors]
enabled = false
`);
  const eventBus = createEventBus();
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 1, ...compactionSettings },
    retry: { enabled: false }, defaultThinkingLevel: "off", transport, cacheWarming: "off",
  });
  const paths = [fileURLToPath(new URL("extensions/codex-compaction.ts", root)), ...extensionPaths];
  if (compactionPolicy !== undefined) {
    const path = join(dir, "metis-pi.toml");
    writeFileSync(path, readFileSync(path, "utf8") + `\n[compactionPolicy]\n${compactionPolicy}\n`);
    paths.push(fileURLToPath(new URL("extensions/compaction-policy.ts", root)));
  }
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
    writeFileSync(entry, `export default function(pi) { pi.registerProvider("other-codex", {
      baseUrl: "https://offline.invalid/backend-api/codex", api: "openai-codex-responses", apiKey: ${JSON.stringify(FAKE_API_KEY)},
      models: [{ id: "other", name: "Other", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    }); }`);
    paths.push(entry);
  }
  const loader = new DefaultResourceLoader({
    eventBus, cwd: dir, agentDir: dir, settingsManager: settings, additionalExtensionPaths: paths,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "COMPACTION TEST",
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime: runtime, sessionManager: sm, settingsManager: settings,
    resourceLoader: loader, model: routeModel, thinkingLevel: "off",
  });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  const notices = [], bodies = [], headers = [], urls = [];
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
  return { session, sm, dir, codexDir, bodies, headers, urls, notices, runtime, eventBus };
}
const compactions = h => h.sm.getBranch().filter(e => e.type === "compaction");

export {
  answer, answerEvents, assistant, checkpointEvents, compactions, completed, createCompactionHost,
  key, model, newOAuthKey, responsesModel, sse, usage, user, writeCodexLogin,
};
