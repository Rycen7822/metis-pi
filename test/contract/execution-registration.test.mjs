import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);
const root = fileURLToPath(new URL("../../", import.meta.url));
test("Pi owns the provider and tool selection while native codemode calls structured metis tools", async t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-execution-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const native = modelRuntime.getRegisteredNativeProvider("openai");
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [join(root, "extensions/execution.ts")], extensionFactories: [createCodemodeExtension({models:false})], noSkills: true, noThemes: true,
    noPromptTemplates: true, noContextFiles: true, systemPrompt: "NATIVE_PROMPT_SENTINEL" });
  await loader.reload();
  const model = { id: "local", name: "local", provider: "execution-proof", api: "openai-completions", baseUrl: "http://invalid", reasoning: false,
    input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const calls = [], usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple: (m, context) => {
    calls.push(context);
    const stream = createAssistantMessageEventStream();
    const content = calls.length === 1 ? [{ type: "toolCall", id: "native-script", name: "codemode", arguments: {
      code: 'const r = await tools.exec_command({cmd:"printf native-proof",yield_time_ms:1000}); text(r);' } }]
      : [{ type: "text", text: "Done" }];
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, content, stopReason: calls.length === 1 ? "toolUse" : "stop", timestamp: Date.now(), usage };
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
  } });
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.create(dir, dir), model });
  t.after(async () => {
    try { await loaded.session.extensionRunner.emit({ type: "session_shutdown" }); }
    finally { loaded.session.dispose(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
  });
  assert.deepEqual(loaded.extensionsResult.errors, []);
  const children = []; loaded.session.subscribe(event => { if (event.type === "tool_execution_end" && event.parentToolCallId) children.push(event); });
  const errors = []; await loaded.session.bindExtensions({ onError: e => errors.push(e) });
  assert.equal(modelRuntime.getRegisteredNativeProvider("openai"), native);
  const initial = loaded.session.getActiveToolNames();
  for (const name of ["read", "bash", "write"]) assert.ok(initial.includes(name), name);
  assert.ok(!initial.includes("exec"));
  loaded.session.setActiveToolsByName([...initial, "codemode"]);
  await loaded.session.prompt("Run the proof"); await loaded.session.waitForIdle();
  assert.deepEqual(errors, []);
  assert.match(JSON.stringify(calls[0]), /NATIVE_PROMPT_SENTINEL/);
  const result = loaded.session.state.messages.find(m => m.role === "toolResult" && m.toolCallId === "native-script");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /native-proof/);
  assert.ok(result.nestedCalls.calls.some(call => call.name === "exec_command"));
  const child = children.find(call => call.toolName === "exec_command");
  assert.equal(child.result.structuredContent.output, "native-proof");
  assert.equal(child.result.structuredContent.exit_code, 0);
  loaded.session.setActiveToolsByName(["read", "codemode", "exec", "wait"]);
  // Loadout hides the second orchestrator and direct callable declarations on the wire.
  calls.length = 1;
  await loaded.session.prompt("Inspect the loadout"); await loaded.session.waitForIdle();
  const declared = calls.at(-1).messages.flatMap(message => message.role === "system" ? message.toolsAdded ?? [] : []).map(tool => tool.name);
  assert.ok(declared.includes("exec") && declared.includes("wait"), JSON.stringify(calls.at(-1).messages.filter(message => message.role === "system")));
  assert.ok(!declared.includes("codemode"));
  assert.ok(declared.includes("read"), "unadapted callable declarations stay available");
});
