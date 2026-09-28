import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { captureBody, disableNetwork, FAKE_API_KEY } from "../helpers/vendor-codex-provider.mjs";
import { createCodexExtensionRuntime } from "../../vendor/pi-codex-conversion/dist/extension/runtime.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test.beforeEach(disableNetwork);

async function host(t, converted, reverse = false, wholePackage = false) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work", "dynamic-host-"));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = { version: 1, notify: false, groups: [
    { id: "a", file: "A.md", include: ["a"] }, { id: "b", file: "B.md", include: ["b"] },
  ] };
  writeFileSync(join(agentDir, "dynamic-agents.json"), JSON.stringify(config));
  writeFileSync(join(agentDir, "AGENTS.md"), "NATIVE_GLOBAL_SENTINEL");
  writeFileSync(join(agentDir, "A.md"), "POLICY_A_SENTINEL");
  writeFileSync(join(agentDir, "B.md"), "POLICY_B_SENTINEL");
  writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_SENTINEL");
  const settingsManager = SettingsManager.inMemory({ packages: wholePackage ? [root] : [], compaction: { enabled: false }, retry: { enabled: false } });
  const bus = createEventBus();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false });
  const provider = converted ? "openai-codex" : "dynamic-test";
  const model = id => ({ id, name: id, provider, api: converted ? "openai-codex-responses" : "openai-completions",
    baseUrl: "http://invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  await modelRuntime.setRuntimeApiKey(provider, converted ? FAKE_API_KEY : "offline");
  const paths = [join(root, "extensions/dynamic-agents.ts"), ...(converted ? [join(root, "vendor/pi-codex-conversion/dist/index.js")] : [])];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus: bus,
    additionalExtensionPaths: wholePackage ? [] : reverse ? paths.reverse() : paths,
    noSkills: true, noThemes: true, noPromptTemplates: true, systemPrompt: "DYNAMIC_TEST" });
  await loader.reload();
  const sm = SessionManager.create(cwd, agentDir);
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: sm, model: model("a") });
  const errors = [], calls = [];
  t.after(async () => {
    try { await session.extensionRunner.emit({ type: "session_shutdown" }); }
    finally { session.dispose(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
  });
  assert.deepEqual(extensionsResult.errors, []);
  if (wholePackage) assert.equal(extensionsResult.extensions.length, 9);
  await session.bindExtensions({ onError: e => errors.push(e) });
  let reply;
  const streamSimple = (m, context) => {
    calls.push({ model: m, context: structuredClone(context) });
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
      content: [{ type: "text", text: "Done." }], stopReason: "stop", timestamp: Date.now(), usage, ...reply?.(calls.length) };
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
  };
  modelRuntime.registerProvider(provider, { api: model("a").api, apiKey: converted ? FAKE_API_KEY : "offline",
    baseUrl: "http://invalid", models: ["a", "b", "other"].map(model), streamSimple });
  return { session, sm, model, calls, errors, bus, config, agentDir, cwd, setReply(fn) { reply = fn; }, async run() { await session.prompt("Continue."); await session.waitForIdle(); assert.deepEqual(errors, []); return calls.at(-1); } };
}

for (const [converted, reverse] of [[false, false], [true, false], [true, true]]) test(`run-boundary replacement preserves sources and project rules, converted=${converted}, reverse=${reverse}`, async t => {
  const h = await host(t, converted, reverse);
  const stateEntries = () => h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-dynamic-agents");
  const warm = () => { const request = { kind: "prewarm", model: h.session.model, allowed: true }; h.bus.emit("metis:dynamic-agents", request); return request.allowed; };
  assert.equal(warm(), false);
  await h.session.setModel(h.model("b")); await h.session.setModel(h.model("a"));
  assert.equal(stateEntries().length, 0); assert.equal(h.calls.length, 0);
  const first = await h.run();
  assert.match(JSON.stringify(first.context), /POLICY_A_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(first.context), /NATIVE_GLOBAL_SENTINEL|POLICY_B_SENTINEL/);
  assert.equal(warm(), true);
  const oldEntries = h.sm.getEntries().map(e => ({ id: e.id, text: JSON.stringify(e) }));
  const diskPrefix = readFileSync(h.sm.getSessionFile(), "utf8");
  await h.session.setModel(h.model("b"));
  assert.equal(warm(), false);
  const second = await h.run();
  assert.match(JSON.stringify(second.context), /POLICY_B_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(second.context), /POLICY_A_SENTINEL|NATIVE_GLOBAL_SENTINEL/);
  assert.match(JSON.stringify(second.context), /PROJECT_SENTINEL/);
  for (const entry of oldEntries) assert.equal(JSON.stringify(h.sm.getEntries().find(e => e.id === entry.id)), entry.text);
  assert.ok(readFileSync(h.sm.getSessionFile(), "utf8").startsWith(diskPrefix));
  if (converted) {
    const body = await captureBody(second.model, second.context, { onPayload: body => h.session.extensionRunner.emitBeforeProviderRequest(body) });
    assert.match(JSON.stringify(body), /POLICY_B_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(body), /POLICY_A_SENTINEL|NATIVE_GLOBAL_SENTINEL/);
    assert.match(JSON.stringify(body), /PROJECT_SENTINEL/);
  }
  await h.session.setModel(h.model("a"));
  const third = await h.run();
  assert.match(JSON.stringify(third.context), /POLICY_A_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(third.context), /POLICY_B_SENTINEL/);
  await h.session.setModel(h.model("other"));
  const fallback = await h.run();
  assert.match(JSON.stringify(fallback.context), /NATIVE_GLOBAL_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(fallback.context), /POLICY_[AB]_SENTINEL/);
  assert.equal(readFileSync(join(h.agentDir, "AGENTS.md"), "utf8"), "NATIVE_GLOBAL_SENTINEL");
  assert.equal(readFileSync(join(h.agentDir, "A.md"), "utf8"), "POLICY_A_SENTINEL");
});

test("policy is frozen across tool steps and refreshes only at the next run", async t => {
  const h = await host(t, false);
  h.setReply(count => {
    if (count !== 1) return;
    writeFileSync(join(h.agentDir, "A.md"), "POLICY_UPDATED_SENTINEL");
    return { content: [{ type: "toolCall", id: "read-project", name: "read", arguments: { path: join(h.cwd, "AGENTS.md") } }], stopReason: "toolUse" };
  });
  await h.run();
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.match(JSON.stringify(call.context), /POLICY_A_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(call.context), /POLICY_UPDATED_SENTINEL/);
  }
  const next = JSON.stringify((await h.run()).context);
  assert.match(next, /POLICY_UPDATED_SENTINEL/); assert.doesNotMatch(next, /POLICY_A_SENTINEL/);
});

test("bad config, disabling, and reload restore native rules without inheriting the last policy", async t => {
  const h = await host(t, false);
  await h.run();
  writeFileSync(join(h.agentDir, "dynamic-agents.json"), "{");
  assert.match(JSON.stringify((await h.run()).context), /NATIVE_GLOBAL_SENTINEL/);
  writeFileSync(join(h.agentDir, "dynamic-agents.json"), JSON.stringify(h.config));
  assert.match(JSON.stringify((await h.run()).context), /POLICY_A_SENTINEL/);
  writeFileSync(join(h.agentDir, "dynamic-agents.json"), JSON.stringify({ ...h.config, groups: [h.config.groups[1]] }));
  await h.session.setModel(h.model("b"));
  await h.session.reload();
  const restored = JSON.stringify((await h.run()).context);
  assert.match(restored, /POLICY_B_SENTINEL/); assert.doesNotMatch(restored, /POLICY_A_SENTINEL/);
  writeFileSync(join(h.agentDir, "dynamic-agents.json"), JSON.stringify({ ...h.config, enabled: false }));
  const result = JSON.stringify((await h.run()).context);
  assert.match(result, /NATIVE_GLOBAL_SENTINEL/); assert.doesNotMatch(result, /POLICY_[AB]_SENTINEL/);
});

test("whole package retains tools and applies dynamic policy", async t => {
  const h = await host(t, false, false, true);
  const call = await h.run();
  const body = JSON.stringify(call.context);
  assert.match(body, /POLICY_A_SENTINEL/); assert.match(body, /PROJECT_SENTINEL/);
  assert.doesNotMatch(body, /NATIVE_GLOBAL_SENTINEL/);
  const names = h.session.getActiveToolNames();
  for (const name of ["read", "write", "create_goal", "context_tree_query"]) assert.ok(names.includes(name), name);
});

test("actual prewarm entry defers unresolved models and uses the same history projection", async t => {
  const h = await host(t, false);
  const runtime = createCodexExtensionRuntime({ events: h.bus });
  t.after(async () => { runtime.shutdownTransport(); await runtime.sessions.shutdown(); await runtime.shutdownDiagnostics(); });
  let accesses = 0;
  const pending = { get model() { if (++accesses > 1) throw new Error("Unresolved policy reached prewarm planning"); return h.model("a"); } };
  assert.equal(runtime.startPrewarm(pending, "OLD_PROMPT"), undefined);
  assert.equal(accesses, 1);
  await h.run(); await h.session.setModel(h.model("b")); await h.run();
  const messages = runtime.projectContextMessages({ model: h.session.model, cwd: h.cwd, sessionManager: h.sm });
  const system = JSON.stringify(messages.filter(m => m.role === "system"));
  assert.match(system, /POLICY_B_SENTINEL/); assert.doesNotMatch(system, /POLICY_A_SENTINEL/);
});
