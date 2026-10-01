import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { disableNetwork, captureRegistration, modelNamed, FAKE_API_KEY } from "../helpers/native-provider.mjs";
import { assistantToolCall, toolResult } from "../helpers/vendor-codex-sessions.mjs";

test.beforeEach(disableNetwork);
const root = new URL("../../", import.meta.url);
const ENTRY = fileURLToPath(new URL("extensions/condense.ts", root));
import { record } from "../helpers/condense-query.mjs";

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
  if (codex) paths.push(fileURLToPath(new URL("extensions/execution.ts", root)));
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

test("Pi native context handlers and final provider payload retain recovery tools and projected results", async (t) => {
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
