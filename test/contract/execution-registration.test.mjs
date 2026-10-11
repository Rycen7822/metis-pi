import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import { disableNetwork } from "../helpers/native-provider.mjs";
import { createExecCommandTool } from "../../src/execution/exec/command-tool.ts";
import { createWriteStdinTool } from "../../src/execution/exec/write-stdin-tool.ts";

test.beforeEach(disableNetwork);
const root = fileURLToPath(new URL("../../", import.meta.url));
test("Pi owns the provider and tool selection while native codemode calls structured metis tools", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "metis-execution-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
  });
  const native = modelRuntime.getRegisteredNativeProvider("openai");
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: [join(root, "extensions/execution.ts")],
    extensionFactories: [createCodemodeExtension({ models: false })],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    systemPrompt: "NATIVE_PROMPT_SENTINEL",
  });
  await loader.reload();
  const model = {
    id: "local",
    name: "local",
    provider: "execution-proof",
    api: "openai-completions",
    baseUrl: "http://invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const calls = [],
    usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  modelRuntime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "offline",
    models: [model],
    streamSimple: (m, context) => {
      calls.push(context);
      const stream = createAssistantMessageEventStream();
      const content =
        calls.length === 1
          ? [
              {
                type: "toolCall",
                id: "native-script",
                name: "codemode",
                arguments: {
                  code: 'const r = await tools.exec_command({cmd:"printf native-proof",yield_time_ms:1000}); text(r);',
                },
              },
            ]
          : [{ type: "text", text: "Done" }];
      const message = {
        role: "assistant",
        api: m.api,
        provider: m.provider,
        model: m.id,
        content,
        stopReason: calls.length === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage,
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
    } finally {
      loaded.session.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  assert.deepEqual(loaded.extensionsResult.errors, []);
  const children = [];
  loaded.session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.parentToolCallId) children.push(event);
  });
  const errors = [];
  await loaded.session.bindExtensions({ onError: (e) => errors.push(e) });
  assert.equal(modelRuntime.getRegisteredNativeProvider("openai"), native);
  const initial = loaded.session.getActiveToolNames();
  for (const name of ["read", "bash", "write"]) assert.ok(initial.includes(name), name);
  loaded.session.setActiveToolsByName([...initial, "codemode"]);
  await loaded.session.prompt("Run the proof");
  await loaded.session.waitForIdle();
  assert.deepEqual(errors, []);
  assert.match(JSON.stringify(calls[0]), /NATIVE_PROMPT_SENTINEL/);
  const result = loaded.session.state.messages.find((m) => m.role === "toolResult" && m.toolCallId === "native-script");
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /native-proof/);
  assert.ok(result.nestedCalls.calls.some((call) => call.name === "exec_command"));
  const child = children.find((call) => call.toolName === "exec_command");
  assert.equal(child.result.structuredContent.output, "native-proof");
  assert.equal(child.result.structuredContent.exit_code, 0);
});

test("exec and write_stdin preserve partial/final evidence in all three result channels", async t => {
  const dir = mkdtempSync(join(tmpdir(), "metis-exec-results-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const command = "printf evidence";
  const partial = Object.freeze({ output: "partial evidence", chunk_id: "partial", wall_time_seconds: 0.25,
    session_id: 7, exit_code: undefined, interrupted: false, fullOutputPath: "/fixture/archive",
    fullOutputBytes: 16, fullOutputComplete: false, fullOutputAppendOnly: true });
  const final = Object.freeze({ output: "final evidence", chunk_id: "final", wall_time_seconds: 0.5,
    session_id: undefined, exit_code: 0, fullOutputPath: "/fixture/archive",
    fullOutputBytes: 30, fullOutputComplete: true, fullOutputAppendOnly: true });
  const deliver = async onUpdate => { onUpdate(partial); return final; };
  const sessions = {
    exec: async (_input, _cwd, _signal, onUpdate) => deliver(onUpdate),
    write: async (_input, _signal, onUpdate) => deliver(onUpdate),
    getSessionCommand: () => command,
  };
  for (const [tool, args] of [[createExecCommandTool(sessions), { cmd: command, shell: "/bin/sh" }],
    [createWriteStdinTool(sessions), { session_id: 7 }]]) {
    const updates = [], result = await tool.execute("fixture", args, undefined, value => updates.push(value), { cwd: dir });
    assert.equal(updates.length, 1, tool.name);
    for (const [delivery, evidence] of [[updates[0], partial], [result, final]]) {
      assert.equal(delivery.details, evidence, "the original evidence object is retained");
      assert.deepEqual(delivery.structuredContent, evidence === partial
        ? { output: "partial evidence", chunk_id: "partial", wall_time_seconds: 0.25, session_id: 7,
          interrupted: false, fullOutputPath: "/fixture/archive", fullOutputBytes: 16, fullOutputComplete: false, fullOutputAppendOnly: true }
        : { output: "final evidence", chunk_id: "final", wall_time_seconds: 0.5, exit_code: 0,
          fullOutputPath: "/fixture/archive", fullOutputBytes: 30, fullOutputComplete: true, fullOutputAppendOnly: true });
      assert.equal(delivery.content.length, 1);
      assert.equal(delivery.content[0].type, "text");
      assert.ok(delivery.content[0].text.startsWith(`Command: ${command}\nChunk ID: ${evidence.chunk_id}\n`));
      assert.ok(delivery.content[0].text.endsWith(`\nOutput:\n${evidence.output}`));
      assert.match(delivery.content[0].text, /Captured output archive: \/fixture\/archive/);
    }
  }
});

test("write_stdin continues to translate session failures at the tool boundary", async () => {
  const tool = createWriteStdinTool({ getSessionCommand: () => "fixture",
    write: async () => { throw new Error("session unavailable"); } });
  await assert.rejects(tool.execute("fixture", { session_id: 7 }, undefined, undefined, {}),
    { message: "write_stdin failed: session unavailable" });
});
