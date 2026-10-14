import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createAgentSession, createCodemodeExtension, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = (result: any) => result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
const args = { questions: [{ question: "Which approach?", header: "Approach", options: [
  { label: "First", description: "First approach" }, { label: "Second", description: "Second approach" },
] }] };

async function fixture(t: any, hasUI: boolean, gateways: boolean | "tool_search" = true, foreign = false) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/ask-sdk-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "metis-pi.toml"), "[askUserQuestion]\nenabled=true\n");
  const warnings: string[] = [];
  let ctx: any, observed: any;
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "model-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const model = { id: "fixture", name: "Offline questions fixture", provider: "ask-contract", api: "openai-completions",
    reasoning: false, input: ["text"], baseUrl: "http://invalid", contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
  runtime.registerProvider(model.provider, { api: model.api, apiKey: "offline", models: [model], streamSimple: (m, context) => {
    observed = context;
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "Fixture done" }], api: m.api,
      provider: m.provider, model: m.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
    return stream;
  } });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "extensions/ask-user-question.ts")],
    extensionFactories: [
      ...(gateways ? [gateways === "tool_search"
        ? { name: "tool_search", builtin: true, factory: createToolSearchExtension() }
        : { name: "codemode", builtin: true, factory: createCodemodeExtension({ models: false }) }] : []),
      { name: "capture-context", factory: (pi: any) => pi.registerTool({ name: "fixture_probe", label: "Probe", description: "Fixture",
        parameters: Type.Object({}), execute: async (_id: string, _args: unknown, _signal: unknown, _update: unknown, context: unknown) => {
          ctx = context; return { content: [], details: {} };
        } }) },
      ...(foreign ? [{ name: "foreign-questions", factory: (pi: any) => pi.registerTool({ name: "ask_user_question", label: "Foreign",
        description: "Foreign question tool", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }) }] : []),
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model,
    settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(dir) });
  t.after(async () => {
    try { await session.abort(); await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true }); }
  });
  const ui = { ...session.extensionRunner!.getUIContext(),
    notify: (message: string) => { warnings.push(message); },
    select: async (_title: string, options: string[]) => options[0], input: async () => "typed",
  };
  await session.bindExtensions({ mode: "rpc", ...(hasUI ? { uiContext: ui as any } : {}) });
  await session.agent.state.tools.find(tool => tool.name === "fixture_probe")!.execute("probe", {});
  return { session, warnings, ui, get ctx() { return ctx; }, get observed() { return observed; },
    runCode: (code: string) => session.agent.state.tools.find(tool => tool.name === "codemode")!.execute("codemode-parent", { code }) };
}

for (const hasUI of [true, false]) test(`real SDK deferred question discovery and execution (hasUI=${hasUI})`, async t => {
  const f = await fixture(t, hasUI);
  const tool = f.session.getAllTools().find(tool => tool.name === "ask_user_question")!;
  assert.equal(tool.exposure, hasUI ? "deferred" : "hidden");
  assert.ok(!f.session.getActiveToolNames().includes(tool.name));
  for (let turn = 0; turn < 2; turn++) await f.session.prompt("Offline declaration snapshot");
  const declarations = f.observed.messages.filter((m: any) => m.role === "system").flatMap((m: any) => m.toolsAdded ?? []);
  assert.ok(declarations.every((tool: any) => tool.name !== "ask_user_question"));
  for (const coder of declarations.filter((tool: any) => tool.name === "codemode"))
    assert.doesNotMatch(coder.description, /ask_user_question\(args:/, "deferred parameter declaration is also absent from codemode inline listings");
  assert.ok(!f.session.getActiveToolNames().includes(tool.name));
  if (hasUI) {
    const description = await f.runCode('text(await describeTool("ask_user_question"));');
    assert.match(output(description), /ask_user_question[\s\S]*questions/);
    const result = await f.runCode(`text(await tools.ask_user_question(${JSON.stringify(args)}));`);
    assert.match(output(result), /First/);
    assert.ok(!f.session.getActiveToolNames().includes(tool.name), "nested execution does not activate direct declarations");
    const direct = await f.ctx.executeTool("ask_user_question", args);
    assert.equal(direct.isError, false);
    assert.equal(direct.result.details.answers[0].answer, "First");
    assert.equal(direct.result.details.cancelled, false);
  } else {
    // No-UI still has a callable codemode gateway; the questionnaire itself is withdrawn.
    f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "codemode"]);
    const description = await f.runCode('text(await describeTool("ask_user_question"));');
    assert.match(output(description), /Script completed/);
    assert.doesNotMatch(output(description), /declare const tools/);
    const rejected = await f.ctx.executeTool("ask_user_question", args);
    assert.equal(rejected.isError, true);
    assert.match(rejected.result.content[0].text, /not callable|not available|Unknown|hidden|not registered|not found/i);
  }
});

test("real SDK no-gateway and foreign-provider guards do not advertise the Metis capability", async t => {
  for (const foreign of [false, true]) {
    const f = await fixture(t, true, false, foreign);
    await f.session.prompt("Offline capability snapshot");
    assert.ok(f.warnings.length > 0);
    assert.ok(f.observed.messages.filter((m: any) => m.role === "system").every((m: any) => !m.sections?.metis_questions));
    if (foreign) assert.equal(f.session.getToolDefinition("ask_user_question")!.description, "Foreign question tool");
  }
});

test("native tool_search loads questions on demand and later turns preserve the explicit activation", async t => {
  const f = await fixture(t, true, "tool_search");
  assert.ok(f.session.getActiveToolNames().includes("tool_search"));
  assert.ok(!f.session.getActiveToolNames().includes("ask_user_question"));
  await f.session.prompt("Offline search gateway snapshot");
  const sections = f.observed.messages.filter((m: any) => m.role === "system").map((m: any) => m.sections?.metis_questions).filter(Boolean);
  assert.ok(sections.some((hint: string) => hint.includes("tool_search")));
  const search = f.session.agent.state.tools.find(tool => tool.name === "tool_search")!;
  const result = await search.execute("search-parent", { query: "ask_user_question" });
  assert.match(output(result), /ask_user_question/);
  assert.ok(f.session.getActiveToolNames().includes("ask_user_question"));
  await f.session.prompt("Offline loaded-tool snapshot");
  assert.ok(f.session.getActiveToolNames().includes("ask_user_question"));
});

test("real SDK RPC abort propagates through custom-answer input without reopening the dialog", { timeout: 10000 }, async t => {
  const f = await fixture(t, true);
  await f.session.prompt("Offline execution context");
  const controller = new AbortController();
  let selections = 0;
  f.ui.select = async (_title, options) => { selections++; return options.at(-1)!; };
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.ui.input = ((_title: string, _placeholder: string, options: any) => new Promise(resolve => {
    assert.ok(options.signal instanceof AbortSignal);
    options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    entered();
  })) as any;
  await f.session.bindExtensions({ mode: "rpc", uiContext: f.ui as any });
  const pending = f.ctx.executeTool("ask_user_question", args, { signal: controller.signal });
  await Promise.race([waiting, pending.then((value: any) => { throw new Error(`Dialog never opened: ${JSON.stringify(value)}`); })]);
  controller.abort();
  assert.equal((await pending).isError, true);
  assert.equal(selections, 1);
  f.ui.select = async (_title, options) => options[0];
  f.ui.input = async () => "typed";
  await f.session.bindExtensions({ mode: "rpc", uiContext: f.ui as any });
  assert.equal((await f.ctx.executeTool("ask_user_question", args)).result.details.cancelled, false);
});
