import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { RuntimeError, SubagentClient, runtimePackage } from "../../src/subagents/client.ts";

test("metis owns native direct and codemode subagents with one wait receipt and isolated SDK children", { timeout: 45000 }, async t => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/metis-subagent-contract-")), state = join(dir, "subagent-pi");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(state);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }));
  writeFileSync(join(state, "config.toml"), '[profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="250"\n[profiles.questioned.env]\nPI_OFFLINE="1"\nPI_MOCK_ASK_PARENT="1"\n[profiles.failed.env]\nPI_OFFLINE="1"\nPI_MOCK_FAIL="1"\nPI_MOCK_STREAM_MS="250"\n');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const model = { id: "parent", name: "Offline Parent", provider: "subagent-contract", api: "openai-completions", baseUrl: "http://invalid",
    reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let turn = 0;
  modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple: (m, context) => {
    const stream = createAssistantMessageEventStream(); turn++;
    let call;
    if (turn === 1) call = { name: "codemode", arguments: { code: 'const a=await tools.pi_spawn_agent({task:"nested proof",access:"read",model:"pi-mock-offline/mock",request_id:"nested-spawn"}); text(await tools.pi_wait_agent({run_ids:[a.run_id],timeout_seconds:15}));' } };
    if (turn === 3) call = { name: "pi_spawn_agent", arguments: { task: "direct proof", access: "read", model: "pi-mock-offline/mock", request_id: "direct-spawn" } };
    if (turn === 4) {
      const spawn = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "pi_spawn_agent");
      call = { name: "pi_wait_agent", arguments: { run_ids: [JSON.parse(spawn.content[0].text).run_id], timeout_seconds: 15 } };
    }
    if (turn === 6) call = { name: "pi_spawn_agent", arguments: { task: "background proof", access: "read", model: "pi-mock-offline/mock", request_id: "background-spawn" } };
    if (turn === 9) call = { name: "pi_spawn_agent", arguments: { task: "ask before proceeding", access: "read", profile: "questioned", model: "pi-mock-offline/mock", request_id: "question-spawn" } };
    if (turn === 10 || turn === 12) {
      const spawn = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "pi_spawn_agent");
      call = { name: "pi_wait_agent", arguments: { run_ids: [JSON.parse(spawn.content[0].text).run_id], timeout_seconds: 15 } };
    }
    if (turn === 11) {
      const wait = context.messages.findLast(message => message.role === "toolResult" && message.toolName === "pi_wait_agent");
      const question = JSON.parse(wait.content[0].text).questions[0];
      assert.ok(question, "a read-only child can ask its parent without bypassing policy");
      call = { name: "pi_answer_agent", arguments: { agent_id: question.agent_id, ui_request_id: question.id, answer: "Use the current isolated branch", request_id: "question-answer" } };
    }
    if (turn === 14) call = { name: "codemode", arguments: { code: 'const a=await tools.pi_spawn_agent({task:"overlap proof",access:"read",model:"pi-mock-offline/mock",request_id:"overlap-spawn"}); text(await Promise.all([tools.pi_wait_agent({run_ids:[a.run_id],timeout_seconds:15}),tools.pi_wait_agent({run_ids:[a.run_id],timeout_seconds:15})]));' } };
    if (turn === 16) call = { name: "pi_spawn_agent", arguments: { task: "must not start", access: "read", model: "no-such-model-xyz", request_id: "failed-direct" } };
    if (turn === 18 || turn === 20) call = { name: "codemode", arguments: { code: `text(await tools.pi_spawn_agent({task:"must not start",access:"read",model:"no-such-model-xyz",request_id:"failed-nested-${turn}"}));${turn === 20 ? 'throw new Error("after the child error");' : ""}` } };
    if (turn === 22) call = { name: "pi_spawn_agent", arguments: { task: "asynchronous failure proof", access: "read", profile: "failed", model: "pi-mock-offline/mock", request_id: "failed-background" } };
    if (turn === 25) {
      const previous = context.messages.find(message => message.role === "toolResult" && message.toolName === "pi_spawn_agent");
      call = { name: "pi_followup_task", arguments: { agent_id: JSON.parse(previous.content[0].text).agent_id, message: "shutdown viewer proof", request_id: "shutdown-followup" } };
    }
    const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
      content: call ? [{ type: "toolCall", id: `call-${turn}`, ...call }] : [{ type: "text", text: "Done" }], stopReason: call ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); return stream;
  } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: [join(root, "extensions/subagents.ts")],
    extensionFactories: [{ builtin: true, name: "codemode", factory: createCodemodeExtension({ models: false }) }],
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.create(dir, dir), model });
  const widgets = [];
  let popup, popupRows = [], popupsClosed = 0, openOnNextWidget = true;
  const uiContext = {
    notify() {}, setStatus() {},
    setWidget(key, content, options) {
      assert.equal(key, "metis-subagents");
      if (content === undefined) { widgets.push([]); return; }
      assert.equal(options.placement, "aboveEditor");
      let widget;
      const render = () => {
        const rows = widget.render(40);
        assert.ok(rows.every(row => visibleWidth(row) <= 40));
        assert.ok(widget.render(1).every(row => visibleWidth(row) <= 1));
        widgets.push(rows);
        if (openOnNextWidget && rows.length) {
          openOnNextWidget = false;
          assert.equal(widget.handleMouse({ type: "click", button: "right", y: 1 }), undefined);
          assert.equal(widget.handleMouse({ type: "wheel", button: "none", y: 1 }), undefined);
          assert.equal(widget.handleMouse({ type: "click", button: "left", y: 0 }), undefined);
          assert.equal(widget.handleMouse({ type: "click", button: "left", y: 2 }).handled, true);
        }
      };
      widget = content({ requestRender: render }, { fg: (_color, text) => text, bold: text => text });
      render();
    },
    custom(factory, options) {
      assert.equal(options.overlay, true);
      return new Promise(resolve => {
        popup = factory({ terminal: { rows: 30 }, requestRender() { if (popup) popupRows = popup.render(60); } },
          { fg: (_color, text) => text }, getKeybindings(), () => {
            popup?.dispose(); popup = undefined; popupsClosed++; resolve(undefined);
          });
      });
    },
  };
  t.after(async () => {
    try {
      await loaded.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      loaded.session.dispose();
      execFileSync("python3", [join(root, "src/subagents/core/bin/subagent-pi"), "--home", state, "daemon", "stop", "--force"], { timeout: 20000 });
      assert.deepEqual(widgets.at(-1), [], "session shutdown clears the subagent widget");
      assert.equal(popupsClosed, 2, "session shutdown also closes the open viewer");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const errors = [], nested = [];
  loaded.session.subscribe(event => { if (event.type === "tool_execution_end" && event.parentToolCallId) nested.push(event); });
  await loaded.session.bindExtensions({ onError: error => errors.push(error), uiContext, mode: "tui" });
  loaded.session.setActiveToolsByName([...loaded.session.getActiveToolNames(), "codemode"]);
  assert.ok(loaded.session.getActiveToolNames().includes("pi_spawn_agent"));
  assert.ok(loaded.session.getActiveToolNames().includes("bash"), "parent keeps native tools");
  await loaded.session.prompt("Run nested proof"); await loaded.session.waitForIdle();
  assert.equal(turn, 2, JSON.stringify(errors));
  assert.equal(nested.filter(event => event.toolName === "pi_wait_agent" && !event.isError).length, 1, JSON.stringify(loaded.session.state.messages.filter(message => message.role === "toolResult")));
  await loaded.session.prompt("Run direct proof"); await loaded.session.waitForIdle();
  assert.equal(turn, 5, JSON.stringify(errors)); assert.deepEqual(errors, []);
  const branch = loaded.session.sessionManager.getBranch();
  assert.equal(branch.filter(entry => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length, 0, "wait prevents a second automatic notification");
  assert.equal(branch.filter(entry => entry.type === "custom" && entry.customType === "metis-subagent-receipt").length, 2);
  assert.ok(widgets.some(rows => rows.some(row => row.includes(" · running"))), "real child activity reaches the above-editor widget");
  const deadlineForWidget = Date.now() + 5000;
  while (widgets.at(-1)?.length && Date.now() < deadlineForWidget) await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(widgets.at(-1), [], "settled children do not remain in the running list");
  const direct = branch.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pi_wait_agent");
  assert.equal(direct.message.isError, false, JSON.stringify(direct));
  assert.equal(JSON.parse(direct.message.content[0].text).runs[0].state, "completed");
  await loaded.session.prompt("Run background proof"); await loaded.session.waitForIdle();
  const deadline = Date.now() + 15000;
  while (turn < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  await loaded.session.waitForIdle(); assert.equal(turn, 8, "unobserved completion still wakes the parent");
  assert.equal(loaded.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length, 1);
  assert.deepEqual(errors, []);
  await loaded.session.prompt("Run question proof"); await loaded.session.waitForIdle();
  assert.equal(turn, 13); assert.deepEqual(errors, []);
  await loaded.session.prompt("Run overlapping wait proof"); await loaded.session.waitForIdle();
  assert.equal(turn, 15); assert.deepEqual(errors, []);
  assert.equal(loaded.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length, 1, "overlapping waits preserve one event receipt");
  for (const [label, expectedTurn] of [["direct", 17], ["nested", 19], ["nested then script error", 21]]) {
    await loaded.session.prompt(`Run failed ${label} proof`); await loaded.session.waitForIdle();
    assert.equal(turn, expectedTurn, "synchronous failure does not trigger a second parent turn");
    const result = loaded.session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "toolResult").message;
    assert.match(result.content.map(block => block.text ?? "").join(""), /invalid_model/);
    assert.equal(result.isError, label !== "nested");
    assert.ok(result.details.metisSubagentReceipt, "direct and nested failures save recovery receipts");
  }
  assert.equal(loaded.session.sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length, 1);
  await loaded.session.prompt("Run asynchronous failure proof"); await loaded.session.waitForIdle();
  const failureDeadline = Date.now() + 15000;
  while (turn < 24 && Date.now() < failureDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  await loaded.session.waitForIdle(); assert.equal(turn, 24, "unobserved asynchronous failure still wakes the parent");
  const attention = loaded.session.sessionManager.getBranch().findLast(entry => entry.customType === "metis-subagent-attention");
  assert.match(attention.content, /failed/);
  const viewDeadline = Date.now() + 5000;
  while (!popupRows.some(row => row.includes("nested proof")) && Date.now() < viewDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(popupRows.some(row => row.includes("nested proof")), `clicked agent's real conversation reaches the overlay: ${popupRows.join("\n")}`);
  assert.ok(popupRows.some(row => row.includes("pi-mock-offline/mock")), "native model identity is readable");
  for (const width of [1, 4, 60]) assert.ok(popup.render(width).every(row => visibleWidth(row) <= width));
  popup.handleInput("\u001b");
  assert.equal(popupsClosed, 1, "Escape closes only the viewer");
  await new Promise(resolve => setTimeout(resolve, 0));
  openOnNextWidget = true;
  await loaded.session.prompt("Run shutdown viewer proof"); await loaded.session.waitForIdle();
  const reopenDeadline = Date.now() + 5000;
  while (!popup && Date.now() < reopenDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(popup, "a completed child's new run reappears and opens its viewer before parent shutdown");
});

test("SDK configuration failures expose their cause and preserve recoverable identities", { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)), runtime = runtimePackage();
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/metis-subagent-config-")), state = join(dir, "subagent-pi");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(state);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }));
  writeFileSync(join(state, "config.toml"), '[profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="50"\n');
  const ctx = { cwd: dir, model: { provider: "pi-mock-offline", id: "mock" },
    sessionManager: SessionManager.create(dir, dir), isProjectTrusted: () => true };
  const client = new SubagentClient(runtime, ctx, dir, undefined, () => {});
  try {
    for (const [request_id, override, code, reason] of [
      ["bad-model", { model: "no-such-model-xyz" }, "invalid_model", /Model .*no-such-model-xyz.*not found/],
      ["bad-thinking", { thinking: "ultra" }, "unsupported_thinking", /Unsupported thinking.*ultra/],
    ]) {
      let failure;
      await assert.rejects(client.call("pi_spawn_agent", { name: "configuration-probe", access: "read", task: "must not start", request_id, ...override }), error => {
        failure = error; assert.ok(error instanceof RuntimeError); assert.equal(error.code, code);
        assert.match(error.message, reason); assert.match(error.message, /agent_id=pi_.*run_id=run_/); return true;
      });
      const inspected = await client.call("pi_inspect_agent", { agent_id: failure.agent_id, detail: "full" });
      assert.equal(inspected.agent.cleanup, "verified"); assert.equal(inspected.run.id, failure.run_id);
      assert.equal(inspected.run.state, "failed"); assert.match(inspected.agent.name, /startup failed/);
      await assert.rejects(client.call("pi_followup_task", { agent_id: failure.agent_id, message: "retry", request_id: `${request_id}-retry` }),
        error => error instanceof RuntimeError && error.code === "worker_unavailable" && /pi_spawn_agent/.test(error.message));
    }
    const started = await client.call("pi_spawn_agent", { name: "configuration-probe", access: "read", task: "recovered", request_id: "fixed-model" });
    assert.equal(started.name, "configuration-probe");
    const waited = await client.call("pi_wait_agent", { run_ids: [started.run_id], timeout_seconds: 15 });
    assert.equal(waited.runs[0].state, "completed");
  } finally {
    await client.close();
    try { execFileSync("python3", [join(runtime.root, "bin/subagent-pi"), "--home", state, "daemon", "stop", "--force"], { stdio: "ignore" }); }
    finally { rmSync(dir, { recursive: true, force: true });
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
  }
});
