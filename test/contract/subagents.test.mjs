import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { RuntimeError, SubagentClient } from "../../src/subagents/host/client.ts";
import { runtimePackage } from "../../src/subagents/host/runtime-package.ts";
import { subagentWidget } from "../../src/subagents/ui/widget.ts";
import { makeSubagentTheme, subagentTheme } from "../helpers/subagent-theme.mjs";
import { subagentAdmin } from "../helpers/subagent-admin.mjs";

function enableAnimation(t) {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
}

test("Bubbles Dot holds a steady startup and uses upstream frames in both color modes", t => {
  enableAnimation(t);
  let now = 0, wall = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => wall);
  // Bubbles spinner.Dot: eight constant-density frames at time.Second / 10.
  const expected = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
  for (const theme of [subagentTheme, makeSubagentTheme("256color")]) {
    now = 0;
    const widget = subagentWidget(theme, () => [{ id: "spinner", name: "worker", state: "running" }], () => {});
    const first = widget.render(80);
    for (now of [99, 300, 599, 600, 699]) assert.deepEqual(widget.render(80), first, "short tasks never start flashing");
    for (let frame = 0; frame <= expected.length; frame++) {
      now = 600 + frame * 100;
      wall = frame % 2 ? -1e9 : 1e9;
      const rows = widget.render(80), icon = stripVTControlCharacters(rows[1])[3];
      assert.equal(icon, expected[frame % expected.length], "phase uses a monotonic clock, not wall time");
      assert.equal((icon.codePointAt(0) & 0xff).toString(2).replace(/0/g, "").length, 7, "constant lit-dot count");
      assert.ok(rows.every(row => visibleWidth(row) <= 80));
      assert.deepEqual([rows[0], rows[2]], [first[0], first[2]], "animation leaves header/activity rows untouched");
      assert.equal(rows[1].replace(icon, expected[0]), first[1], "only the one-cell glyph changes, never its color or layout");
    }
  }
});

test("Bubbles Dot starts per agent and resets after leaving the running state", t => {
  enableAnimation(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let agents = [{ id: "old", name: "old", state: "running" }];
  const widget = subagentWidget(subagentTheme, () => agents, () => {});
  const icons = () => widget.render(80).filter((_row, i) => i % 2 === 1).map(row => stripVTControlCharacters(row)[3]);
  assert.deepEqual(icons(), ["⣾"]);
  now = 700;
  agents = [...agents.map(agent => ({ ...agent })), { id: "new", name: "new", state: "running" }];
  assert.deepEqual(icons(), ["⣽", "⣾"], "watch snapshots must not restart old animation; new agents get their own delay");
  agents = [{ id: "old", name: "old", state: "needs_input" }];
  assert.deepEqual(icons(), ["?"]);
  now = 1000;
  agents = [{ id: "old", name: "old", state: "running" }];
  assert.deepEqual(icons(), ["⣾"]);
  now = 1700;
  assert.deepEqual(icons(), ["⣽"]);
  agents = [];
  assert.deepEqual(widget.render(80), []);
  agents = [{ id: "old", name: "old", state: "running" }];
  assert.deepEqual(icons(), ["⣾"], "removed agents cannot retain an old clock");
});

test("Bubbles Dot respects static motion policy and NO_COLOR", t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const previous = process.env.NO_COLOR;
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  const agents = () => [{ id: "spinner", name: "worker", state: "running" }];
  for (const noColor of [false, true]) {
    if (noColor) process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
    const widget = subagentWidget(subagentTheme, agents, () => {}, noColor);
    now = 0;
    const first = widget.render(80);
    now = 7700;
    assert.deepEqual(widget.render(80), first, "explicit disabled motion or NO_COLOR keeps a nonblank static glyph");
  }
});

test("native subagent registration honors the global switch without starting backend work", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = mkdtempSync(join(root, ".work/metis-subagent-disabled-")),
    previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "metis-pi.toml"), "[subagents]\nenabled=false\n");
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [join(root, "extensions/subagents.ts")],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0].tools.size, 0);
  assert.equal(loaded.extensions[0].commands.has("metis-subagents"), false);
});

function stopDaemon(core, state) {
  subagentAdmin({ root: core }, state, "shutdown", { force: true });
  // Shutdown is accepted before guards finish writing their cleanup receipts.
  execFileSync("python3", ["-c", `import fcntl,sys,time
with open(sys.argv[1], 'rb') as lock:
    until=time.monotonic()+10
    while True:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.monotonic()>=until: raise TimeoutError('Daemon shutdown did not release its lease')
            time.sleep(.025)
`,
      join(state, "daemon.lock"),
    ],
    { timeout: 12000 },
  );
}

test(
  "metis discovers deferred native subagents through codemode and preserves explicit direct calls and receipts",
  { timeout: 45000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    mkdirSync(join(root, ".work"), { recursive: true });
    const dir = mkdtempSync(join(root, ".work/metis-subagent-contract-")),
      state = join(dir, "metis", "subagent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }),
    );
    // Keep the first child active beyond the viewer's one-second poll so its live conversation is observable.
    writeFileSync(
      join(dir, "metis-pi.toml"),
      '[subagents]\nmaxResidentAgents=4\n[subagents.profiles.reader.env]\nPI_OFFLINE="1"\nP' +
        'I_MOCK_STREAM_MS="250"\n[subagents.profiles.questioned.env]\nPI_OFFLINE="1"\nPI_MOC' +
        'K_ASK_PARENT="1"\n[subagents.profiles.failed.env]\nPI_OFFLINE="1"\nPI_MOCK_FAIL="1"' +
        '\nPI_MOCK_STREAM_MS="250"\n[subagents.profiles.viewer.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="1500"\n',
    );
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"),
      refreshOnCreate: false,
    });
    const model = {
      id: "parent",
      name: "Offline Parent",
      provider: "subagent-contract",
      api: "openai-completions",
      baseUrl: "http://invalid",
      reasoning: false,
      input: ["text"],
      contextWindow: 100000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    let turn = 0,
      backgroundBeforeReply = false;
    modelRuntime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "offline",
      models: [model],
      streamSimple: (m, context) => {
        const stream = createAssistantMessageEventStream();
        turn++;
        let call;
        if (turn === 1) {
          const systemMessages = context.messages.filter(message => message.role === "system");
          assert.match(systemMessages.map(message => message.sections?.metis_subagents ?? "").join("\n"), /Subagent tools are deferred in the subagents namespace/);
          const modelTools = systemMessages.flatMap(message => message.toolsAdded ?? []);
          assert.ok(modelTools.some(tool => tool.name === "codemode"));
          assert.ok(runtimePackage().tools.every(tool => !modelTools.some(declared => declared.name === tool.name)), "model receives no independent native subagent declarations");
          call = {
            name: "codemode",
            arguments: {
              code:
                'const ns=await describeNamespace("subagents"); if(!ns || !ns.tools.includes("pi_spawn_agent")) throw new Error("namespace missing"); ' +
                'const found=await searchTools("spawn task",{namespace:"subagents",limit:1}); if(found[0]?.name!=="pi_spawn_agent") throw new Error("spawn discovery failed"); ' +
                'const a=await tools[found[0].name]({name:"nested-proof",task:"nested ' +
                'proof",access:"read",profile:"viewer",model:"pi-mock-offline/mock"}); if(!a.request_id) throw ' +
                'new Error("missing operation identity"); text(await ' +
                'tools.pi_wait_agent({agent_ids:["nested-proof"],timeout_seconds:15}));',
            },
          };
        }
        if (turn === 3)
          call = {
            name: "pi_spawn_agent",
            arguments: { name: "direct-proof", task: "direct proof", access: "read", model: "pi-mock-offline/mock" },
          };
        if (turn === 4) {
          const spawn = context.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "pi_spawn_agent",
          );
          assert.ok(JSON.parse(spawn.content[0].text).request_id);
          call = { name: "pi_wait_agent", arguments: { agent_ids: ["direct-proof"], timeout_seconds: 15 } };
        }
        if (turn === 6)
          call = {
            name: "pi_spawn_agent",
            arguments: {
              task: "background proof",
              access: "read",
              model: "pi-mock-offline/mock",
              request_id: "background-spawn",
            },
          };
        if (turn === 7) {
          const spawn = context.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "pi_spawn_agent",
          );
          const path = join(state, "results", `${JSON.parse(spawn.content[0].text).run_id}.txt`);
          call = {
            name: "bash",
            arguments: {
              command: `while ! test -f '${path.replaceAll("'", "'\"'\"'")}'; do sleep 0.05; done`,
              timeout: 15,
            },
          };
        }
        if (turn === 8)
          backgroundBeforeReply = context.messages.some((message) =>
            message.content?.some?.(
              (block) =>
                block.type === "text" &&
                block.text.startsWith("Subagent results and questions") &&
                block.text.includes("MOCK_REPLY_1"),
            ),
          );
        if (turn === 9)
          call = {
            name: "pi_spawn_agent",
            arguments: {
              task: "ask before proceeding",
              access: "read",
              profile: "questioned",
              model: "pi-mock-offline/mock",
              request_id: "question-spawn",
            },
          };
        if (turn === 10 || turn === 12) {
          const spawn = context.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "pi_spawn_agent",
          );
          call = {
            name: "pi_wait_agent",
            arguments: { run_ids: [JSON.parse(spawn.content[0].text).run_id], timeout_seconds: 15 },
          };
        }
        if (turn === 11) {
          const wait = context.messages.findLast(
            (message) => message.role === "toolResult" && message.toolName === "pi_wait_agent",
          );
          const question = JSON.parse(wait.content[0].text).questions[0];
          assert.ok(question, "a read-only child can ask its parent without bypassing policy");
          call = {
            name: "pi_answer_agent",
            arguments: { agent_id: question.name, answer: "Use the current isolated branch" },
          };
        }
        if (turn === 14)
          call = {
            name: "codemode",
            arguments: {
              code:
                'const a=await tools.pi_spawn_agent({task:"overlap ' +
                'proof",access:"read",model:"pi-mock-offline/mock",request_id:"overlap-spawn"}); ' +
                "text(await Promise.all([tools.pi_wait_agent({run_ids:[a.run_id],timeout_seconds:" +
                "15}),tools.pi_wait_agent({run_ids:[a.run_id],timeout_seconds:15})]));",
            },
          };
        if (turn === 16)
          call = {
            name: "pi_spawn_agent",
            arguments: {
              task: "must not start",
              access: "read",
              model: "no-such-model-xyz",
              request_id: "failed-direct",
            },
          };
        if (turn === 18 || turn === 20)
          call = {
            name: "codemode",
            arguments: {
              code:
                'text(await tools.pi_spawn_agent({task:"must not ' +
                'start",access:"read",model:"no-such-model-xyz",request_id:"failed-nested-' +
                `${turn}` +
                '"}));' +
                `${turn === 20 ? 'throw new Error("after the child error");' : ""}`,
            },
          };
        if (turn === 22)
          call = {
            name: "pi_spawn_agent",
            arguments: {
              task: "asynchronous failure proof",
              access: "read",
              profile: "failed",
              model: "pi-mock-offline/mock",
              request_id: "failed-background",
            },
          };
        if (turn === 25)
          call = {
            name: "pi_spawn_agent",
            arguments: { cwd: join(dir, "missing"), task: "must not start", request_id: "missing-cwd-direct" },
          };
        if (turn === 27)
          call = {
            name: "codemode",
            arguments: {
              code:
                "const r=await tools.pi_spawn_agent({cwd:" +
                `${JSON.stringify(join(dir, "missing"))}` +
                ',task:"must not start",request_id:"missing-cwd-nested"}); ' +
                'if(r.isError!==true||r.error?.code!=="invalid_cwd") throw new Error("missing ' +
                'structured preflight error"); text(r);',
            },
          };
        if (turn === 29)
          call = {
            name: "pi_followup_task",
            arguments: {
              agent_id: "pi_missing_preflight",
              message: "must not start",
              request_id: "missing-agent-preflight",
            },
          };
        if (turn === 31) {
          const previous = context.messages.find(
            (message) => message.role === "toolResult" && message.toolName === "pi_spawn_agent",
          );
          call = {
            name: "pi_followup_task",
            arguments: {
              agent_id: JSON.parse(previous.content[0].text).agent_id,
              message: "shutdown viewer proof",
              request_id: "shutdown-followup",
            },
          };
        }
        const message = {
          role: "assistant",
          api: m.api,
          provider: m.provider,
          model: m.id,
          timestamp: Date.now(),
          content: call ? [{ type: "toolCall", id: `call-${turn}`, ...call }] : [{ type: "text", text: "Done" }],
          stopReason: call ? "toolUse" : "stop",
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
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      additionalExtensionPaths: [join(root, "extensions/subagents.ts")],
      extensionFactories: [{ builtin: true, name: "codemode", factory: createCodemodeExtension({ models: false }) }],
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const loaded = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.create(dir, dir),
      model,
    });
    const widgets = [];
    let popup,
      popupRows = [],
      popupsClosed = 0,
      openOnNextWidget = true;
    const uiContext = {
      notify() {},
      setStatus() {},
      setWidget(key, content, options) {
        assert.equal(key, "metis-subagents");
        if (content === undefined) {
          widgets.push([]);
          return;
        }
        assert.equal(options.placement, "aboveEditor");
        let widget;
        const render = () => {
          const rows = widget.render(40);
          assert.ok(rows.every((row) => visibleWidth(row) <= 40));
          assert.ok(widget.render(1).every((row) => visibleWidth(row) <= 1));
          widgets.push(rows);
          if (openOnNextWidget && rows.length) {
            openOnNextWidget = false;
            assert.equal(widget.handleMouse({ type: "click", button: "right", y: 1 }), undefined);
            assert.equal(widget.handleMouse({ type: "wheel", button: "none", y: 1 }), undefined);
            assert.equal(widget.handleMouse({ type: "click", button: "left", y: 0 }), undefined);
            assert.equal(widget.handleMouse({ type: "click", button: "left", y: 2 }).handled, true);
          }
        };
        widget = content({ requestRender: render }, subagentTheme);
        render();
      },
      custom(factory, options) {
        assert.equal(options.overlay, true);
        return new Promise((resolve) => {
          popup = factory(
            {
              terminal: { rows: 30 },
              requestRender() {
                if (!popup) return;
                const current = popup, rows = current.render(60);
                // Capture live frames; completion removes the view, not its test evidence.
                if (rows.length) popupRows.push(...rows);
                for (const width of [1, 4, 60]) assert.ok(current.render(width).every((row) => visibleWidth(row) <= width));
              },
            },
            { fg: (_color, text) => text },
            getKeybindings(),
            () => {
              popup?.dispose();
              popup = undefined;
              popupsClosed++;
              resolve(undefined);
            },
          );
        });
      },
    };
    t.after(async () => {
      try {
        await loaded.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        loaded.session.dispose();
        stopDaemon(join(root, "src/subagents/backend"), state);
        assert.deepEqual(widgets.at(-1), [], "session shutdown clears the subagent widget");
        assert.equal(popupsClosed, 2, "session shutdown also closes the open viewer");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const errors = [],
      nested = [];
    loaded.session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.parentToolCallId) nested.push(event);
    });
    await loaded.session.bindExtensions({ onError: (error) => errors.push(error), uiContext, mode: "tui" });
    const initialTools = loaded.session.getActiveToolNames();
    assert.ok(initialTools.includes("codemode"), "native codemode dependency activates without changing caller settings");
    for (const tool of runtimePackage().tools) {
      assert.equal(initialTools.includes(tool.name), false, "native tools are not initially declared directly");
      const registered = loaded.session.getAllTools().find(item => item.name === tool.name);
      assert.equal(registered.exposure, "deferred");
      assert.equal(registered.namespace.name, "subagents");
    }
    assert.equal(initialTools.includes("tool_search"), false);
    assert.ok(initialTools.includes("bash"), "parent keeps native tools");
    await loaded.session.prompt("Run nested proof");
    await loaded.session.waitForIdle();
    assert.equal(turn, 2, JSON.stringify({ errors, assistantErrors: loaded.session.state.messages.filter(message => message.role === "assistant").map(message => message.errorMessage?.slice(0, 1200)) }));
    assert.equal(
      nested.filter((event) => event.toolName === "pi_wait_agent" && !event.isError).length,
      1,
      JSON.stringify(loaded.session.state.messages.filter((message) => message.role === "toolResult")),
    );
    assert.ok(runtimePackage().tools.every(tool => !loaded.session.getActiveToolNames().includes(tool.name)), "script discovery does not activate independent declarations");
    // Direct API compatibility is opt-in; the default model interface stays codemode.
    loaded.session.setActiveToolsByName([...initialTools, ...runtimePackage().tools.map(tool => tool.name)]);
    await loaded.session.prompt("Run direct proof");
    await loaded.session.waitForIdle();
    assert.equal(turn, 5, JSON.stringify(errors));
    assert.deepEqual(errors, []);
    const branch = loaded.session.sessionManager.getBranch();
    assert.equal(
      branch.filter((entry) => entry.type === "custom_message" && entry.customType === "metis-subagent-attention")
        .length,
      0,
      "wait prevents a second automatic notification",
    );
    assert.equal(
      branch.filter((entry) => entry.type === "custom" && entry.customType === "metis-subagent-receipt").length,
      2,
    );
    assert.ok(
      widgets.some((rows) => rows.some((row) => row.includes(" · running"))),
      "real child activity reaches the above-editor widget",
    );
    const deadlineForWidget = Date.now() + 5000;
    while (widgets.at(-1)?.length && Date.now() < deadlineForWidget)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(widgets.at(-1), [], "settled children do not remain in the running list");
    const direct = branch.find(
      (entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pi_wait_agent",
    );
    assert.equal(direct.message.isError, false, JSON.stringify(direct));
    assert.equal(JSON.parse(direct.message.content[0].text).runs[0].state, "completed");
    await loaded.session.prompt("Run background proof");
    await loaded.session.waitForIdle();
    const deadline = Date.now() + 15000;
    while (turn < 8 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    await loaded.session.waitForIdle();
    assert.equal(turn, 8, "a ready background result does not add a second final response");
    assert.equal(backgroundBeforeReply, true, "completion during a tool turn reaches the model before its final reply");
    assert.equal(
      loaded.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length,
      1,
    );
    const delivered = loaded.session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom_message" && entry.customType === "metis-subagent-attention");
    const body = JSON.parse(delivered.content.slice(delivered.content.indexOf("\n") + 1));
    assert.equal(body.runs[0].result.text, "MOCK_REPLY_1");
    assert.equal(body.runs[0].result.has_more, false, "a complete automatic result needs no second read");
    assert.deepEqual(errors, []);
    await loaded.session.prompt("Run question proof");
    await loaded.session.waitForIdle();
    assert.equal(turn, 13);
    assert.deepEqual(errors, []);
    await loaded.session.prompt("Run overlapping wait proof");
    await loaded.session.waitForIdle();
    assert.equal(turn, 15);
    assert.deepEqual(errors, []);
    const deliveryBranch = loaded.session.sessionManager.getBranch();
    const automaticNotices = deliveryBranch.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "metis-subagent-attention",
    );
    const automaticEvents = automaticNotices.flatMap(
      (entry) => JSON.parse(entry.content.slice(entry.content.indexOf("\n") + 1)).events,
    );
    const automaticIds = automaticEvents.map((event) => event.notification_id);
    assert.equal(new Set(automaticIds).size, automaticIds.length, JSON.stringify(automaticEvents));
    const waitedIds = new Set(deliveryBranch
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
      .flatMap((entry) => entry.message.details?.metisSubagentReceipt?.events ?? []));
    assert.ok(
      automaticIds.every((id) => !waitedIds.has(id)),
      `waits and automatic delivery must not repeat an event: ${JSON.stringify(automaticEvents)}`,
    );
    for (const [label, expectedTurn] of [
      ["direct", 17],
      ["nested", 19],
      ["nested then script error", 21],
    ]) {
      await loaded.session.prompt(`Run failed ${label} proof`);
      await loaded.session.waitForIdle();
      assert.equal(turn, expectedTurn, "synchronous failure does not trigger a second parent turn");
      const result = loaded.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult").message;
      assert.match(result.content.map((block) => block.text ?? "").join(""), /invalid_model/);
      assert.equal(result.isError, label !== "nested");
      assert.ok(result.details.metisSubagentReceipt, "direct and nested failures save recovery receipts");
    }
    assert.equal(
      loaded.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom_message" && entry.customType === "metis-subagent-attention").length,
      automaticNotices.length,
      "synchronous failures do not create background notifications",
    );
    const failureSettled = new Promise((resolve) => {
      const off = loaded.session.subscribe((event) => {
        if (event.type === "agent_settled" && turn >= 24) { off(); resolve(); }
      });
      t.after(off);
    });
    await loaded.session.prompt("Run asynchronous failure proof");
    await failureSettled;
    await loaded.session.waitForIdle();
    assert.equal(turn, 24, "unobserved asynchronous failure still wakes the parent");
    const attention = loaded.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.customType === "metis-subagent-attention");
    assert.match(attention.content, /failed/);
    for (const [label, expectedTurn, code] of [
      ["direct cwd", 26, "invalid_cwd"],
      ["nested cwd", 28, "invalid_cwd"],
      ["missing followup", 30, "agent_not_found"],
    ]) {
      await loaded.session.prompt(`Run ${label} preflight proof`);
      await loaded.session.waitForIdle();
      assert.equal(turn, expectedTurn);
      const result = loaded.session.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult").message;
      assert.equal(result.isError, label !== "nested cwd");
      assert.match(result.content.map((block) => block.text ?? "").join(""), new RegExp(`"code":"${code}"`));
      if (label !== "nested cwd") assert.equal(JSON.parse(result.content[0].text).error.code, code);
    }
    assert.equal(
      loaded.session.sessionManager.getBranch().filter((entry) => entry.customType === "metis-subagent-attention")
        .length,
      automaticNotices.length + 1,
      "preflight errors do not create background failure notifications",
    );
    const viewDeadline = Date.now() + 5000;
    while (!popupRows.some((row) => row.includes("nested proof")) && Date.now() < viewDeadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(
      popupRows.some((row) => row.includes("nested proof")),
      `clicked agent's real conversation reaches the overlay: ${popupRows.join("\n")}`,
    );
    assert.ok(
      popupRows.some((row) => row.includes("pi-mock-offline/mock")),
      "native model identity is readable",
    );
    assert.equal(popup, undefined, "the viewer does not remain open for settled history");
    assert.equal(popupsClosed, 1, "the viewer closes automatically when no active agents remain");
    await new Promise((resolve) => setTimeout(resolve, 0));
    openOnNextWidget = true;
    await loaded.session.prompt("Run shutdown viewer proof");
    await loaded.session.waitForIdle();
    const reopenDeadline = Date.now() + 5000;
    while (!popup && Date.now() < reopenDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(popup, "a completed child's new run reappears and opens its viewer before parent shutdown");
    const header = popup.render(60)[1];
    assert.match(header, /\[direct-proof\]/);
    assert.doesNotMatch(header, /\[<\]|\[>\]|nested-proof/, "reopening shows the active child, not earlier completed agents or their extra pages");
  },
);

test(
  "SDK configuration failures preserve identities and result delivery survives rereads",
  { timeout: 30000 },
  async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url)),
      runtime = runtimePackage();
    mkdirSync(join(root, ".work"), { recursive: true });
    const dir = mkdtempSync(join(root, ".work/metis-subagent-config-")),
      state = join(dir, "metis", "subagent");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }),
    );
    writeFileSync(
      join(dir, "metis-pi.toml"),
      '[subagents.profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="50"\n[subagents' +
        '.profiles.slow.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="5000"\n',
    );
    const ctx = {
      cwd: dir,
      model: { provider: "pi-mock-offline", id: "mock" },
      sessionManager: SessionManager.create(dir, dir),
      isProjectTrusted: () => true,
    };
    const client = new SubagentClient(runtime, ctx, dir, undefined, () => {});
    try {
      for (const [request_id, override, code, reason] of [
        ["bad-model", { model: "no-such-model-xyz" }, "invalid_model", /Model .*no-such-model-xyz.*not found/],
        ["bad-thinking", { thinking: "ultra" }, "unsupported_thinking", /Unsupported thinking.*ultra/],
      ]) {
        let failure;
        await assert.rejects(
          client.call("pi_spawn_agent", {
            name: "configuration-probe",
            access: "read",
            task: "must not start",
            request_id,
            ...override,
          }),
          (error) => {
            failure = error;
            assert.ok(error instanceof RuntimeError);
            assert.equal(error.code, code);
            assert.match(error.message, reason);
            assert.match(error.message, /agent_id=pi_.*run_id=run_/);
            return true;
          },
        );
        const inspected = await client.call("pi_inspect_agent", { agent_id: failure.agent_id, detail: "full" });
        assert.equal(inspected.agent.cleanup, "verified");
        assert.equal(inspected.run.id, failure.run_id);
        assert.equal(inspected.run.state, "failed");
        assert.match(inspected.agent.name, /startup failed/);
        for (const receipt of inspected._pi_delivery.receipts) await client.call("pi_observe", { receipt });
        await assert.rejects(
          client.call("pi_followup_task", {
            agent_id: failure.agent_id,
            message: "retry",
            request_id: `${request_id}-retry`,
          }),
          (error) =>
            error instanceof RuntimeError &&
            error.code === "worker_unavailable" &&
            /pi_spawn_agent/.test(error.message),
        );
      }
      const started = await client.call("pi_spawn_agent", {
        name: "configuration-probe",
        access: "read",
        task: "recovered",
        request_id: "fixed-model",
      });
      assert.equal(started.name, "configuration-probe");
      const waited = await client.call("pi_wait_agent", { run_ids: [started.run_id], timeout_seconds: 15 });
      assert.equal(waited.runs[0].state, "completed");
      for (const receipt of waited._pi_delivery.receipts) await client.call("pi_release", { receipt });
      for (const [operation, args] of [
        ["pi_agent_result", { run_id: started.run_id }],
        ["pi_inspect_agent", { agent_id: started.agent_id }],
      ]) {
        const ui = await client.call(operation, args, undefined, { consume: false });
        assert.equal(ui._pi_delivery, undefined, "internal UI reads preserve unseen attention");
        const result = await client.call(operation, args);
        assert.ok(result._pi_delivery?.receipts.length, `${operation} prepares a durable delivery receipt`);
        for (const receipt of result._pi_delivery.receipts) await client.call("pi_release", { receipt });
        assert.ok(
          (await client.call("pi_watch", {})).notifications.some((event) => event.run_id === started.run_id),
          "unpersisted delivery remains eligible for wakeup",
        );
      }
      const listed = await client.call("pi_list_agents", {});
      assert.equal(listed.outstanding.total, 1);
      assert.equal(listed._pi_delivery, undefined, "listing completion status does not deliver the result");
      assert.ok(
        (await client.call("pi_watch", {})).notifications.some((event) => event.run_id === started.run_id),
        "listing preserves automatic result attention",
      );
      const delivered = await client.call("pi_agent_result", { run_id: started.run_id });
      for (const receipt of delivered._pi_delivery.receipts) await client.call("pi_observe", { receipt });
      assert.equal((await client.call("pi_wait_agent", { timeout_seconds: 0 })).runs.length, 0);
      assert.equal((await client.call("pi_list_agents", {})).outstanding.total, 0);
      assert.equal(
        (await client.call("pi_agent_result", { run_id: started.run_id })).result_sha256,
        delivered.result_sha256,
      );
      assert.equal((await client.call("pi_watch", {})).notifications.length, 0);
      const interruptible = await client.call("pi_spawn_agent", {
        task: "interrupt before completion",
        profile: "slow",
        access: "read",
        request_id: "interruptible",
      });
      const stopped = await client.call("pi_interrupt_agent", { agent_id: interruptible.agent_id, request_id: "stop" });
      assert.equal(stopped.run_id, interruptible.run_id);
      for (const receipt of stopped._pi_delivery.receipts) await client.call("pi_observe", { receipt });
      assert.equal(
        (await client.call("pi_watch", {})).notifications.length,
        0,
        "the parent's own interruption does not become a late notification",
      );
      assert.equal((await client.call("pi_agent_result", { run_id: stopped.run_id })).run.state, "interrupted");
    } finally {
      await client.close();
      try {
        stopDaemon(runtime.root, state);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
      }
    }
  },
);
