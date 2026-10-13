import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createCodemodeExtension,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { startHttp } from "../helpers/mcp-server.mjs";

test("native codemode owns MCP calls, permissions and resource results alongside then-run", async (t) => {
  const fixture = await startHttp(),
    dir = mkdtempSync(join(tmpdir(), "metis-mcp-contract-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "metis-pi.json"), JSON.stringify({ mcp: { enabled: true } }));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: fixture.url } } }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
  });
  let denied = 0;
  const permission = (pi) =>
    pi.on("tool_call", (event) => {
      if (event.toolName === "mcp__fixture__echo" && event.input.value === 99) {
        denied++;
        return { block: true, reason: "fixture denied" };
      }
    });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: [
      join(root, "extensions/mcp.ts"),
      join(root, "extensions/action-fusion.ts"),
      join(root, "extensions/execution.ts"),
    ],
    extensionFactories: [
      { builtin: true, name: "codemode", factory: createCodemodeExtension({ models: false }) },
      permission,
    ],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = {
    id: "local",
    name: "local",
    provider: "mcp-proof",
    api: "openai-completions",
    baseUrl: "http://invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let turn = 0;
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "offline",
    models: [model],
    streamSimple: (m) => {
      const stream = createAssistantMessageEventStream();
      turn++;
      const code =
        turn === 1
          ? 'const ns=await describeNamespace("fixture"); if(!ns?.tools.includes("mcp__fixture__echo")) throw new Error("server alias missing"); ' +
            'const found=await searchTools("echo",{namespace:"fixture",limit:1}); if(found[0]?.name!=="mcp__fixture__echo") throw new Error("server alias search missing"); ' +
            "const r=await tools.mcp__fixture__echo({value:42,domainError:true}); " +
            "text({value:r.structuredContent.value,isError:r.isError}); const list=await " +
            'tools.list_mcp_resources({server:"fixture"}); text(list); text(await ' +
            'tools.read_mcp_resource({server:"fixture",uri:"data://plain"})); text(await ' +
            'tools.read_mcp_resource({server:"fixture",uri:"data://panel"})); text(await ' +
            'tools.write({path:"proof.txt",content:"native-fusion",then_run:{command:"printf ' +
            'fusion-proof"}}));'
          : "try { await tools.mcp__fixture__echo({value:99}); } catch(e) { text(String(e)); }";
      const content =
        turn <= 2
          ? [{ type: "toolCall", id: `cell-${turn}`, name: "codemode", arguments: { code } }]
          : [{ type: "text", text: "Done" }];
      const message = {
        role: "assistant",
        api: m.api,
        provider: m.provider,
        model: m.id,
        content,
        stopReason: turn <= 2 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
      return stream;
    },
  });
  const loaded = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(dir, dir),
    model,
  });
  t.after(async () => {
    try {
      await loaded.session.extensionRunner.emit({ type: "session_shutdown" });
      loaded.session.dispose();
      await fixture.close();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const children = [],
    errors = [];
  loaded.session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.parentToolCallId) children.push(event);
  });
  await loaded.session.bindExtensions({ onError: (error) => errors.push(error) });
  assert.ok(loaded.session.getActiveToolNames().includes("codemode"), "default MCP exposure activates native codemode");
  assert.ok(loaded.session.getActiveToolNames().includes("bash"), "normal tools remain active");
  await loaded.session.prompt("Run local contract");
  await loaded.session.waitForIdle();
  assert.deepEqual(errors, []);
  const first = loaded.session.state.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === "cell-1",
  );
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(JSON.stringify(first.content), /fusion-proof|then_run:succeeded/);
  assert.match(JSON.stringify(first.content), /resource-body/);
  assert.doesNotMatch(JSON.stringify(first), /UI_SECRET|ui:\/\/panel/);
  assert.equal(readFileSync(join(dir, "proof.txt"), "utf8"), "native-fusion");
  assert.equal(denied, 1);
  assert.equal(fixture.state.calls, 1, "permission blocked the second MCP request");
  assert.equal(
    children.filter((event) => event.toolName === "mcp__fixture__echo").length,
    2,
    "each nested call uses one Pi execution chain",
  );
  const succeeded = children.find((event) => event.toolName === "mcp__fixture__echo" && event.result.structuredContent);
  assert.equal(succeeded.result.structuredContent.structuredContent.value, 42);
  assert.equal(succeeded.result.structuredContent.isError, true, "MCP domain errors retain the script result");
});

async function lateNativeSession(t, code, resultConfiguration = {}, serverNames = ["late-docs"]) {
  const dir = mkdtempSync(join(tmpdir(), "metis-mcp-native-late-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const log = join(dir, "stdio.log"), gate = join(dir, "ready"), schema = join(dir, "schema.json");
  const payloadSchema = { type: "object", properties: { token: { type: "string" } }, required: ["token"] };
  writeFileSync(schema, JSON.stringify({ type: "integer", outputSchema: {
    type: "object", $defs: { Payload: payloadSchema },
    properties: { value: { $ref: "#/$defs/Payload" } }, required: ["value"],
  }, structuredContent: { value: { token: "local-ref-proof" } }, ...resultConfiguration }));
  writeFileSync(join(dir, "metis-pi.toml"), "[mcp]\nenabled=true\n");
  const fixtures = new Map(serverNames.map((name, index) => [name, index ? {
    log: join(dir, `${name}.log`), gate: join(dir, `${name}.ready`),
  } : { log, gate }]));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries([...fixtures].map(([name, paths]) => [name, {
    command: process.execPath,
    args: [fileURLToPath(new URL("../helpers/mcp-server.mjs", import.meta.url)), "stdio", paths.log, schema],
    env: { MCP_FIXTURE_LIST_GATE: paths.gate, MCP_FIXTURE_FAIL_RESOURCES: "1" },
  }])) }));
  let session, reached;
  const reach = new Promise(resolve => { reached = resolve; });
  t.after(async () => {
    try { await session?.extensionRunner.emit({ type: "session_shutdown" }); session?.dispose(); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../../extensions/mcp.ts", import.meta.url))],
    extensionFactories: [{ builtin: true, name: "codemode", factory: pi => createCodemodeExtension({ models: false })({
      ...pi, registerTool(definition) {
        pi.registerTool({ ...definition, reachesTools(input) { reached(); return definition.reachesTools(input); } });
      },
    }) }], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const model = { id: "mock", name: "Mock", provider: "mcp-late-proof", api: "openai-completions", baseUrl: "http://invalid",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let turn = 0;
  modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple(m) {
    const stream = createAssistantMessageEventStream();
    const content = ++turn === 1 ? [{ type: "toolCall", id: "late-cell", name: "codemode", arguments: { code } }]
      : [{ type: "text", text: "Done" }];
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, content,
      stopReason: turn === 1 ? "toolUse" : "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
  } });
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.create(dir, dir), model }));
  const errors = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  assert.ok(!session.getAllTools().some(tool => tool.name === "mcp__late_docs__echo"), "fixture remains unregistered after startup window");
  return { session, reach, gate, log, errors, fixtures };
}

test("first native codemode discovery waits for late stdio tools and sees relocated result declarations", { timeout: 15000 }, async t => {
  const code = 'const ns=await describeNamespace("late-docs"); if(!ns?.tools.includes("mcp__late_docs__echo")) throw new Error("late namespace missing"); ' +
    'const found=await searchTools("echo",{namespace:"late-docs",limit:1}); if(found[0]?.name!=="mcp__late_docs__echo") throw new Error("late search missing"); ' +
    'const declaration=await describeTool("mcp__late_docs__echo"); if(!declaration.includes("token: string") || !declaration.includes("resource?: {") || !declaration.includes("uri: string") || !declaration.includes("_meta?: { [key: string]: unknown; }")) throw new Error("result declaration missing: "+declaration); ' +
    'const result=await tools.mcp__late_docs__echo({value:1}); const embedded=result.content.find(block=>block.type==="resource" && block.resource.uri==="data://plain"); ' +
    'if(embedded?.resource._meta?.source!=="fixture") throw new Error("embedded metadata missing"); text(result.structuredContent.value.token); text(embedded.resource.text);';
  const loaded = await lateNativeSession(t, code);
  const running = loaded.session.prompt("Run local late discovery");
  await loaded.reach;
  assert.doesNotMatch(readFileSync(loaded.log, "utf8"), /call:/);
  writeFileSync(loaded.gate, "ready");
  await running;
  await loaded.session.waitForIdle();
  assert.deepEqual(loaded.errors, []);
  const result = loaded.session.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "late-cell");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /local-ref-proof/);
  assert.match(JSON.stringify(result.content), /embedded-body/);
  const events = readFileSync(loaded.log, "utf8");
  assert.equal(events.split("\n").filter(line => line.startsWith("call:")).length, 1);
  assert.doesNotMatch(events, /resources\/list|resources\/templates\/list/);
});

test("native literal MCP call waits only for its server with a similar namespace prefix", { timeout: 15000 }, async t => {
  const loaded = await lateNativeSession(t, 'text((await tools.mcp__late_docs2__echo({value:1})).structuredContent.value.token);', {}, ["late-docs", "late-docs2"]);
  const running = loaded.session.prompt("Run one late server");
  await loaded.reach;
  const first = loaded.fixtures.get("late-docs"), target = loaded.fixtures.get("late-docs2");
  assert.match(readFileSync(first.log, "utf8"), /tools\/list/);
  assert.match(readFileSync(target.log, "utf8"), /tools\/list/);
  writeFileSync(target.gate, "ready");
  await running;
  await loaded.session.waitForIdle();
  const result = loaded.session.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "late-cell");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /local-ref-proof/);
  assert.doesNotMatch(readFileSync(first.log, "utf8"), /call:/);
  assert.equal(readFileSync(target.log, "utf8").split("\n").filter(line => line.startsWith("call:")).length, 1);
  assert.deepEqual(loaded.errors, []);
});

test("cancelling a native codemode call stops a targeted late-server wait without dispatch", { timeout: 15000 }, async t => {
  const loaded = await lateNativeSession(t, 'text(await tools.mcp__late_docs__echo({value:1}));');
  const running = loaded.session.prompt("Cancel local late call");
  await loaded.reach;
  await loaded.session.abort();
  await running;
  await loaded.session.waitForIdle();
  assert.doesNotMatch(readFileSync(loaded.log, "utf8"), /call:/, "aborted wait sends no MCP tool request");
  assert.deepEqual(loaded.errors, []);
});

test("native codemode receives primitive and null MCP results without an output schema restriction", { timeout: 15000 }, async t => {
  const values = [null, false, 0, "primitive", [1, null], { nested: "json" }];
  const code = 'const declaration=await describeTool("mcp__late_docs__echo"); if(!declaration.includes("structuredContent?: unknown")) throw new Error("unknown result declaration missing"); ' +
    `for (const value of ${JSON.stringify(values)}) { const result=await tools.mcp__late_docs__echo({value}); ` +
    'if(JSON.stringify(result.structuredContent)!==JSON.stringify(value)) throw new Error("structured result changed"); text(result.structuredContent); }';
  const loaded = await lateNativeSession(t, code, { type: undefined, outputSchema: {}, omitContent: true, returnInputStructuredContent: true });
  const running = loaded.session.prompt("Run local structured values");
  await loaded.reach;
  writeFileSync(loaded.gate, "ready");
  await running;
  await loaded.session.waitForIdle();
  assert.deepEqual(loaded.errors, []);
  const result = loaded.session.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "late-cell");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(readFileSync(loaded.log, "utf8").split("\n").filter(line => line.startsWith("call:")).length, values.length);
});

test("first native resource call waits inside its gateway before a late server reports capabilities", { timeout: 15000 }, async t => {
  const code = 'let failed=false; try { await tools.list_mcp_resources({server:"late-docs"}); } catch { failed=true; } ' +
    'if(!failed) throw new Error("resource listing failure missing"); ' +
    'const resource=await tools.read_mcp_resource({server:"late-docs",uri:"data://plain"}); text(resource.contents[0].text);';
  const loaded = await lateNativeSession(t, code);
  let started;
  const gateway = new Promise(resolve => { started = resolve; });
  loaded.session.subscribe(event => {
    if (event.type === "tool_execution_start" && event.parentToolCallId && event.toolName === "list_mcp_resources") started();
  });
  const running = loaded.session.prompt("Run first local resource call");
  await gateway;
  assert.doesNotMatch(readFileSync(loaded.log, "utf8"), /resources\/list|resources\/read/);
  writeFileSync(loaded.gate, "ready");
  await running;
  await loaded.session.waitForIdle();
  assert.deepEqual(loaded.errors, []);
  const result = loaded.session.state.messages.find(message => message.role === "toolResult" && message.toolCallId === "late-cell");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /resource-body/);
  const events = readFileSync(loaded.log, "utf8");
  assert.equal(events.split("\n").filter(line => line === "resources/list").length, 1);
  assert.equal(events.split("\n").filter(line => line === "resources/read").length, 1);
  assert.doesNotMatch(events, /resources\/templates\/list/);
});
