import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import subagents from "../../extensions/subagents.ts";
import { runtimePackage } from "../../src/subagents/host/runtime-package.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ownPath = join(root, "extensions/subagents.ts");
const runtime = runtimePackage();

async function fixture(t, { coder = true, coderPath = "builtin:codemode", coderActive = false, hideNative = false, allowed, enabled = true } = {}) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/subagent-exposure-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "metis-pi.toml"), `[subagents]\nenabled=${enabled}\n`);
  const definitions = new Map(), handlers = new Map(), commands = new Map(), warnings = [];
  let active = ["read", "bash"];
  for (const name of active) definitions.set(name, { name, sourceInfo: { path: "builtin" }, exposure: "direct" });
  if (coder) definitions.set("codemode", { name: "codemode", sourceInfo: { path: coderPath }, exposure: "model-only" });
  if (coderActive) active.push("codemode");
  const pi = {
    on(name, handler) { const rows = handlers.get(name) ?? []; rows.push(handler); handlers.set(name, rows); },
    registerTool(tool) {
      definitions.set(tool.name, { ...tool, sourceInfo: { path: ownPath } });
      if ((tool.exposure ?? "direct") === "direct" && !active.includes(tool.name)) active.push(tool.name);
      if (tool.exposure === "hidden") active = active.filter(name => name !== tool.name);
    },
    getAllTools: () => [...definitions.values()].filter(tool => !hideNative || !runtime.tools.some(native => native.name === tool.name)),
    getActiveTools: () => [...active],
    setActiveTools: names => { active = names.filter(name => definitions.has(name) && (!allowed || allowed.includes(name))); },
    registerMessageRenderer() {}, registerCommand: (name, command) => commands.set(name, command),
    appendEntry() {}, sendMessage() {},
  };
  const ctx = {
    cwd: dir, mode: "rpc", isIdle: () => false, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => dir, getBranch: () => [] },
    ui: { notify: (text, level) => warnings.push({ text, level }), setStatus() {}, setWidget() {} },
  };
  async function emit(name, event = {}) {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  }
  t.after(async () => {
    try { await emit("session_shutdown"); }
    finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  subagents(pi);
  await emit("session_start");
  const before = async (sections = { unrelated: "keep this section" }) => {
    const event = { systemPrompt: "original prompt", systemPromptOptions: { sections } };
    await emit("before_agent_start", event);
    return event;
  };
  return { pi, definitions, warnings, commands, before };
}

test("native subagents register deferred namespace without changing schemas or other tool choices", async t => {
  const f = await fixture(t);
  for (const tool of runtime.tools) {
    const registered = f.definitions.get(tool.name);
    assert.equal(registered.exposure, "deferred");
    assert.equal(registered.namespace.name, "subagents");
    assert.deepEqual(registered.parameters, tool.inputSchema);
    assert.deepEqual(registered.outputSchema, tool.outputSchema);
    assert.deepEqual(registered.annotations, tool.annotations);
  }
  assert.deepEqual(f.pi.getActiveTools(), ["read", "bash", "codemode"]);
  assert.equal(f.commands.has("metis-subagents"), true);
  assert.deepEqual(f.warnings, []);
});

test("discovery hint is one structured section, not an opaque full prompt override", async t => {
  const f = await fixture(t);
  const first = await f.before();
  const sections = first.systemPromptOptions.sections;
  assert.equal(sections.unrelated, "keep this section");
  assert.match(sections.metis_subagents, /codemode/);
  assert.match(sections.metis_subagents, /describeNamespace|searchTools/);
  assert.match(sections.metis_subagents, /isError/);
  assert.match(sections.metis_subagents, /not_consumed/);
  assert.equal(first.systemPrompt, "original prompt");
  assert.equal(first.systemPromptOptions.forceSystemPrompt, undefined);
  const second = await f.before({ ...sections });
  assert.deepEqual(second.systemPromptOptions.sections, sections, "repeated preparation does not append duplicate hints");
});

for (const [label, options] of [["missing builtin", { coder: false }], ["explicit tool restriction", { allowed: ["read", "bash"] }]]) {
  test(`${label} keeps deferred tools registered but warns once instead of advertising an unavailable caller`, async t => {
    const f = await fixture(t, options);
    for (const tool of runtime.tools) assert.equal(f.definitions.get(tool.name).exposure, "deferred");
    const event = await f.before({ metis_subagents: "stale capability hint", unrelated: "keep" });
    await f.before();
    assert.ok(!f.pi.getActiveTools().includes("codemode"));
    assert.equal(event.systemPromptOptions.sections.metis_subagents, undefined);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0].text, /codemode/);
    assert.equal(f.warnings[0].level, "warning");
  });
}

test("explicitly disabling codemode is respected until the next session start", async t => {
  const f = await fixture(t);
  f.pi.setActiveTools(["read", "bash"]);
  const event = await f.before({ metis_subagents: "stale" });
  assert.deepEqual(f.pi.getActiveTools(), ["read", "bash"]);
  assert.equal(event.systemPromptOptions.sections.metis_subagents, undefined);
  assert.equal(f.warnings.length, 1);
});

test("provider conflict hides owned tools and removes their hint without disabling shared codemode", async t => {
  const f = await fixture(t);
  f.definitions.set("Agent", { name: "Agent", sourceInfo: { path: "/foreign/agent.ts" } });
  const event = await f.before({ metis_subagents: "stale", unrelated: "keep" });
  for (const tool of runtime.tools) assert.equal(f.definitions.get(tool.name).exposure, "hidden");
  assert.equal(event.systemPromptOptions.sections.metis_subagents, undefined);
  assert.equal(event.systemPromptOptions.sections.unrelated, "keep");
  assert.ok(f.pi.getActiveTools().includes("codemode"));
});

test("active foreign codemode is preserved but not advertised as native discovery", async t => {
  const f = await fixture(t, { coderPath: "/foreign/codemode.ts", coderActive: true });
  const event = await f.before({ metis_subagents: "stale" });
  assert.ok(f.pi.getActiveTools().includes("codemode"), "foreign caller's tool choice is preserved");
  assert.equal(event.systemPromptOptions.sections.metis_subagents, undefined);
  assert.equal(f.warnings.length, 1);
});

for (const coderActive of [false, true]) {
  test(`filtered native tools do not advertise a namespace or activate an unneeded caller (coderActive=${coderActive})`, async t => {
    const f = await fixture(t, { hideNative: true, coderActive });
    const event = await f.before({ metis_subagents: "stale" });
    assert.equal(event.systemPromptOptions.sections.metis_subagents, undefined);
    assert.equal(f.pi.getActiveTools().includes("codemode"), coderActive);
    assert.deepEqual(f.warnings, []);
  });
}

for (const [label, selection] of [
  ["allowlist", { tools: ["read", "bash", "codemode"] }],
  ["exclusion", { excludeTools: ["pi_*"] }],
]) {
  test(`real SDK ${label} removes native tools and their namespace hint`, async t => {
    mkdirSync(join(root, ".work"), { recursive: true });
    const dir = mkdtempSync(join(root, ".work/subagent-sdk-exposure-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "metis-pi.toml"), "[subagents]\nenabled=true\n");
    let session;
    t.after(async () => {
      try { await session?.abort(); session?.dispose(); }
      finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    const model = { id: "fixture", name: "Offline exposure fixture", provider: "subagent-exposure-contract",
      api: "openai-completions", baseUrl: "http://invalid", reasoning: false, input: ["text"],
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let observed;
    modelRuntime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model],
      streamSimple: (m, context) => {
        observed = context;
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", content: [{ type: "text", text: "Fixture done" }], api: m.api,
          provider: m.provider, model: m.id, stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [ownPath], extensionFactories: [{ name: "codemode", builtin: true,
        factory: createCodemodeExtension({ models: false }) }] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), ...selection }));
    await session.bindExtensions({ mode: "rpc" });
    const activeBefore = session.getActiveToolNames();
    assert.ok(!runtime.tools.some(tool => session.getAllTools().some(registered => registered.name === tool.name)));
    assert.equal(activeBefore.includes("codemode"), label === "allowlist", "filtered feature must not enable an unneeded dependency");
    await session.prompt("Local declaration snapshot");
    assert.equal(session.getLastAssistantText(), "Fixture done");
    assert.ok(observed);
    const system = observed.messages.filter(message => message.role === "system");
    assert.ok(system.every(message => !message.sections?.metis_subagents));
    assert.ok(system.flatMap(message => message.toolsAdded ?? []).every(tool => !runtime.tools.some(native => native.name === tool.name)));
  });
}

test("disabled subagents neither activate codemode nor add a discovery hint", async t => {
  const f = await fixture(t, { enabled: false });
  assert.deepEqual(f.pi.getActiveTools(), ["read", "bash"]);
  assert.ok(runtime.tools.every(tool => !f.definitions.has(tool.name)));
  assert.equal((await f.before()).systemPromptOptions.sections.metis_subagents, undefined);
  assert.deepEqual(f.warnings, []);
});
