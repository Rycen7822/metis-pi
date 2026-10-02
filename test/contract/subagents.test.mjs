import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";

test("metis owns native direct and codemode subagents with one wait receipt and isolated SDK children", { timeout: 45000 }, async t => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "metis-subagent-contract-")), state = join(dir, "subagent-pi");
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(state);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }));
  writeFileSync(join(state, "config.toml"), '[profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="250"\n[profiles.questioned.env]\nPI_OFFLINE="1"\nPI_MOCK_ASK_PARENT="1"\n');
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
  let clickable, popup, popupRows = [], popupsClosed = 0;
  const uiContext = {
    notify() {}, setStatus() {},
    setWidget(key, content, options) {
      assert.equal(key, "metis-subagents");
      if (content === undefined) { widgets.push([]); return; }
      assert.equal(options.placement, "aboveEditor");
      const widget = content({}, { fg: (_color, text) => text });
      clickable ??= widget;
      const rows = widget.render(40);
      assert.ok(rows.every(row => visibleWidth(row) <= 40));
      assert.ok(widget.render(1).every(row => visibleWidth(row) <= 1));
      widgets.push(rows);
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
  assert.equal(clickable.handleMouse({ type: "click", button: "right", y: 1 }), undefined);
  assert.equal(clickable.handleMouse({ type: "wheel", button: "none", y: 1 }), undefined);
  assert.equal(clickable.handleMouse({ type: "click", button: "left", y: 0 }), undefined);
  assert.equal(clickable.handleMouse({ type: "click", button: "left", y: 1 }).handled, true);
  const viewDeadline = Date.now() + 5000;
  while (!popupRows.some(row => row.includes("nested proof")) && Date.now() < viewDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(popupRows.some(row => row.includes("nested proof")), "clicked agent's real conversation reaches the overlay");
  assert.ok(popupRows.some(row => row.includes("pi-mock-offline/mock")), "native model identity is readable");
  for (const width of [1, 4, 60]) assert.ok(popup.render(width).every(row => visibleWidth(row) <= width));
  popup.handleInput("\u001b");
  assert.equal(popupsClosed, 1, "Escape closes only the viewer");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(clickable.handleMouse({ type: "click", button: "left", y: 1 }).handled, true);
});
