import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      contextPrune: { enabled: true, chainCompression: { enabled: false }, purgeErrors: { enabled: false } },
    }),
  );
  const originalSettings = readFileSync(join(dir, "settings.json"), "utf8");
  const settingsManager = SettingsManager.inMemory();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
  });
  const sm = SessionManager.inMemory(dir);
  for (const entry of extraEntries) entry(sm);
  const paths = [ENTRY];
  if (external) {
    const externalPath = join(dir, "external.ts");
    writeFileSync(
      externalPath,
      'export default function(pi) { pi.registerTool({name:"context_tree_query",label:"' +
        'external",description:"external",parameters:{type:"object",properties:{}},async ' +
        'execute(){return {content:[{type:"text",text:"external"}],details:{}}}}); }',
    );
    paths.push(externalPath);
  }
  if (codex) paths.push(fileURLToPath(new URL("extensions/execution.ts", root)));
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({
    eventBus,
    cwd: dir,
    agentDir: dir,
    settingsManager,
    additionalExtensionPaths: paths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "CONDENSE_TEST",
  });
  await resourceLoader.reload();
  const loaded = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    modelRuntime,
    resourceLoader,
    sessionManager: sm,
    ...(codex ? { model: modelNamed("gpt-6-astra") } : {}),
  });
  const errors = [],
    notices = [],
    statuses = new Map();
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

test("real host loads one built-in tool, preserves settings, and uses one token-only prune status", async (t) => {
  const h = await loadHost(t);
  const runner = h.session.extensionRunner;
  const tools = runner.getAllRegisteredTools().map((x) => x.definition);
  assert.equal(tools.filter((x) => x.name === "context_tree_query").length, 1);
  const pruner = runner.getRegisteredCommands().find((x) => x.name === "pruner");
  assert.ok(pruner);
  assert.ok(!(await pruner.getArgumentCompletions("")).some((item) => item.value === "tree"));
  await h.session.prompt("/pruner help");
  assert.ok(!h.notices.at(-1).includes("/pruner tree"));
  await h.session.prompt("/pruner tree");
  assert.match(h.notices.at(-1), /Unknown subcommand: "tree"/);
  await h.session.prompt("/pruner recovery-grace");
  assert.ok(h.notices.some((text) => text.includes("Current recovery grace: 3 user-turn-group")), "the command must dispatch through AgentSession");
  assert.equal(h.statuses.get("context-prune"), "│ prune: ON · usage: 0 tokens");
  h.eventBus.emit("cost:external", { source: "pi-condense", totalCost: 0.02, inputTokens: 200, outputTokens: 10 });
  assert.equal(h.statuses.get("metis-condense-cost"), undefined);
  assert.equal(h.statuses.get("context-prune"), "│ prune: ON · usage: 0 tokens");
  await runner.emit({ type: "session_start" });
  assert.equal(h.statuses.get("metis-condense-cost"), undefined);
  assert.equal(runner.getAllRegisteredTools().filter((x) => x.definition.name === "context_tree_query").length, 1);
  assert.deepEqual(h.errors, []);
});

test("recovery output folds compact JSON, expands by native controls and never changes its data", async (t) => {
  initTheme("dark", false);
  const archive = Array.from({ length: 200 }, (_, i) => `ARCHIVE_${i} 中文😀 historical output for display`).join("\n") + "\nARCHIVE_TAIL_MARKER";
  const h = await loadHost(t, { extraEntries: [sm => sm.appendCustomEntry("context-prune-index", { toolCalls: [record("archived", archive)] })] });
  const tool = h.session.extensionRunner.getAllRegisteredTools().find(x => x.definition.name === "context_tree_query").definition;
  const args = { toolCallIds: ["archived"] };
  const result = await tool.execute("query", args, undefined, undefined, { sessionManager: h.sm });
  assert.equal(JSON.parse(result.content[0].text).results[0].text, archive);
  assert.equal(result.content[0].text.split("\n").length, 1);
  const original = JSON.stringify(result);
  const row = new ToolExecutionComponent(tool.name, "query", args, { showImages: false }, tool, { requestRender() {} }, process.cwd());
  row.updateResult(result, false);
  for (const width of [40, 80, 120]) {
    row.setExpanded(false);
    const collapsed = row.render(width);
    assert.ok(collapsed.length <= 8, `collapsed recovery must stay compact at width ${width}, got ${collapsed.length} rows`);
    assert.doesNotMatch(stripVTControlCharacters(collapsed.join("\n")), /ARCHIVE_TAIL_MARKER/);
    row.setExpanded(true);
    const expanded = row.render(width);
    assert.ok(expanded.length > collapsed.length);
    assert.match(stripVTControlCharacters(expanded.join("\n")), /ARCHIVE_TAIL_MARKER/);
    assert.ok([...collapsed, ...expanded].every(line => visibleWidth(line) <= width));
  }
  row.setExpanded(false);
  const collapsed = row.render(80);
  const hint = collapsed.findIndex(line => stripVTControlCharacters(line).includes("to expand"));
  assert.ok(hint >= 0, "folded output keeps the host's expand-key hint");
  assert.equal(row.handleMouse({ type: "click", button: "left", x: 3, y: hint, width: 80, height: collapsed.length }).handled, true);
  assert.match(stripVTControlCharacters(row.render(80).join("\n")), /ARCHIVE_TAIL_MARKER/);
  row.setExpanded(false);
  assert.ok(row.render(80).length <= 8, "native collapse remains reversible after a mouse expansion");
  assert.equal(JSON.stringify(result), original, "display-only rendering must preserve content, details and cursor bytes");
});

test("recovery errors remain visible and single-line fallback previews stay bounded", async (t) => {
  initTheme("dark", false);
  const h = await loadHost(t);
  const tool = h.session.extensionRunner
    .getAllRegisteredTools()
    .find((x) => x.definition.name === "context_tree_query").definition;
  const args = { toolCallIds: ["missing"] };
  const result = await tool.execute("query", args, undefined, undefined, { sessionManager: h.sm });
  assert.equal(result.isError, true);
  const row = new ToolExecutionComponent(
    tool.name,
    "query",
    args,
    { showImages: false },
    tool,
    { requestRender() {} },
    process.cwd(),
  );
  row.updateResult(result, false);
  assert.match(stripVTControlCharacters(row.render(80).join("\n")), /Not found/);
  const failure = {
    content: [{ type: "text", text: "READ_FAILURE_MARKER " + "x".repeat(20000) + " ERROR_TAIL_MARKER" }],
    details: undefined,
    isError: true,
  };
  row.updateResult(failure, false);
  for (const width of [40, 80, 120]) {
    row.setExpanded(false);
    const collapsed = stripVTControlCharacters(row.render(width).join("\n"));
    assert.ok(collapsed.split("\n").length <= 10);
    assert.match(collapsed, /READ_FAILURE_MARKER/);
    assert.doesNotMatch(collapsed, /ERROR_TAIL_MARKER/);
    row.setExpanded(true);
    assert.match(stripVTControlCharacters(row.render(width).join("\n")), /ERROR_TAIL_MARKER/);
  }
  row.updateResult({ content: [{ type: "text", text: "PARTIAL_ARCHIVE_MARKER" }], details: undefined }, true);
  row.setExpanded(false);
  assert.doesNotMatch(stripVTControlCharacters(row.render(80).join("\n")), /PARTIAL_ARCHIVE_MARKER/);
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
  const tools = h.session.extensionRunner
    .getAllRegisteredTools()
    .map(({ definition: { name, description, parameters } }) => ({ name, description, parameters }))
    .filter((tool) => active.has(tool.name));
  await capture.registration
    .streamSimple(model, { systemPrompt: "CONDENSE_TEST", messages, tools }, { apiKey: FAKE_API_KEY })
    .result();
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
