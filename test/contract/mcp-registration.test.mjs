import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { startHttp } from "../helpers/mcp-server.mjs";

test("native codemode owns MCP calls, permissions and resource results alongside then-run", async t => {
  const fixture = await startHttp(), dir = mkdtempSync(join(tmpdir(), "metis-mcp-contract-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "metis-pi.json"), JSON.stringify({ mcp: { enabled: true } }));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fixture.url } } }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  let denied = 0;
  const permission = pi => pi.on("tool_call", event => {
    if (event.toolName === "mcp__fixture__echo" && event.input.value === 99) { denied++; return { block: true, reason: "fixture denied" }; }
  });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [join(root, "extensions/mcp.ts"), join(root, "extensions/action-fusion.ts"), join(root, "extensions/execution.ts")],
    extensionFactories: [{ builtin: true, name: "codemode", factory: createCodemodeExtension({ models: false }) }, permission],
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const model = { id: "local", name: "local", provider: "mcp-proof", api: "openai-completions", baseUrl: "http://invalid", reasoning: false,
    input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let turn = 0;
  modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple: m => {
    const stream = createAssistantMessageEventStream(); turn++;
    const code = turn === 1 ? 'const r=await tools.mcp__fixture__echo({value:42,domainError:true}); text({value:r.structuredContent.value,isError:r.isError}); const list=await tools.list_mcp_resources({server:"fixture"}); text(list); text(await tools.read_mcp_resource({server:"fixture",uri:"data://plain"})); text(await tools.write({path:"proof.txt",content:"native-fusion",then_run:{command:"printf fusion-proof"}}));' :
      'try { await tools.mcp__fixture__echo({value:99}); } catch(e) { text(String(e)); }';
    const content = turn <= 2 ? [{ type: "toolCall", id: `cell-${turn}`, name: "codemode", arguments: { code } }] : [{ type: "text", text: "Done" }];
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, content, stopReason: turn <= 2 ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
  } });
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.create(dir, dir), model });
  t.after(async () => {
    try { await loaded.session.extensionRunner.emit({ type: "session_shutdown" }); loaded.session.dispose(); await fixture.close(); }
    finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
  });
  const children = [], errors = [];
  loaded.session.subscribe(event => { if (event.type === "tool_execution_end" && event.parentToolCallId) children.push(event); });
  await loaded.session.bindExtensions({ onError: error => errors.push(error) });
  assert.ok(loaded.session.getActiveToolNames().includes("codemode"), "default MCP exposure activates native codemode");
  assert.ok(loaded.session.getActiveToolNames().includes("bash"), "normal tools remain active");
  await loaded.session.prompt("Run local contract"); await loaded.session.waitForIdle();
  assert.deepEqual(errors, []);
  const first = loaded.session.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "cell-1");
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(JSON.stringify(first.content), /fusion-proof|then_run:succeeded/);
  assert.match(JSON.stringify(first.content), /resource-body/); assert.doesNotMatch(JSON.stringify(first), /UI_SECRET|ui:\/\/panel/);
  assert.equal(readFileSync(join(dir, "proof.txt"), "utf8"), "native-fusion");
  assert.equal(denied, 1); assert.equal(fixture.state.calls, 1, "permission blocked the second MCP request");
  assert.equal(children.filter(event => event.toolName === "mcp__fixture__echo").length, 2, "each nested call uses one Pi execution chain");
  const succeeded = children.find(event => event.toolName === "mcp__fixture__echo" && event.result.structuredContent);
  assert.equal(succeeded.result.structuredContent.structuredContent.value, 42);
  assert.equal(succeeded.result.structuredContent.isError, true, "MCP domain errors retain the script result");
});
