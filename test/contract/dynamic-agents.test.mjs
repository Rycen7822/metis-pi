import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { captureBody, disableNetwork, FAKE_API_KEY } from "../helpers/native-provider.mjs";
import { METIS_EVENTS } from "../../src/collaboration.ts";
import { stringify } from "smol-toml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
test.beforeEach(disableNetwork);

async function host(t, converted, reverse = false, wholePackage = false, lifecycle = {}) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work", "dynamic-host-"));
  const agentDir = join(dir, "agent"), cwd = join(dir, "project");
  mkdirSync(agentDir); mkdirSync(cwd);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const config = { version: 1, notify: false, groups: [
    { id: "a", file: "A.md", include: ["a"] }, { id: "b", file: "B.md", include: ["b"] },
  ] };
  writeFileSync(join(agentDir, "metis-pi.toml"), stringify({ dynamicAgents: { ...config, enabled: true },
    ...(lifecycle.web ? { webAccess: {
      workflow: "summary-review", autoOpenBrowser: false, webSearch: { allowedProviders: ["exa"] },
    } } : {}),
  }));
  writeFileSync(join(agentDir, "AGENTS.md"), "NATIVE_GLOBAL_SENTINEL");
  writeFileSync(join(agentDir, "A.md"), "POLICY_A_SENTINEL");
  writeFileSync(join(agentDir, "B.md"), "POLICY_B_SENTINEL");
  writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_SENTINEL");
  const settingsManager = SettingsManager.inMemory({
    packages: wholePackage ? [root] : [],
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const bus = createEventBus();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const provider = converted ? "openai-codex" : "dynamic-test";
  const model = (id) => ({
    id,
    name: id,
    provider,
    api: converted ? "openai-codex-responses" : "openai-completions",
    baseUrl: "http://invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  await modelRuntime.setRuntimeApiKey(provider, converted ? FAKE_API_KEY : "offline");
  const paths = [
    join(root, "extensions/dynamic-agents.ts"),
    ...(converted ? [join(root, "extensions/execution.ts")] : []),
    ...(lifecycle.goal ? [join(root, "extensions/goal.ts")] : []),
    ...(lifecycle.web ? [join(root, "extensions/web-access.ts")] : []),
  ];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: bus,
    additionalExtensionPaths: wholePackage ? [] : reverse ? paths.reverse() : paths,
    extensionFactories: lifecycle.factories ?? [],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    systemPrompt: "DYNAMIC_TEST",
  });
  await loader.reload();
  const sm = SessionManager.create(cwd, agentDir);
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    sessionManager: sm,
    model: model("a"),
  });
  const errors = [],
    calls = [];
  t.after(async () => {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown" });
    } finally {
      session.dispose();
      if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = old;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  assert.deepEqual(extensionsResult.errors, []);
  if (wholePackage) assert.deepEqual(
    extensionsResult.extensions.map(extension => extension.path).sort(),
    readdirSync(join(root, "extensions")).filter(name => name.endsWith(".ts"))
      .map(name => join(root, "extensions", name)).sort(),
  );
  await session.bindExtensions({ onError: (e) => errors.push(e),
    ...(lifecycle.ui ? { uiContext: { ...session.extensionRunner.getUIContext() } } : {}),
  });
  let reply;
  const streamSimple = (m, context) => {
    calls.push({ model: m, context: structuredClone(context) });
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      api: m.api,
      provider: m.provider,
      model: m.id,
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage,
      ...reply?.(calls.length, context),
    };
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
    return stream;
  };
  modelRuntime.registerProvider(provider, {
    api: model("a").api,
    apiKey: converted ? FAKE_API_KEY : "offline",
    baseUrl: "http://invalid",
    models: ["a", "b", "other"].map(model),
    streamSimple,
  });
  return {
    session,
    sm,
    model,
    calls,
    errors,
    bus,
    config,
    agentDir,
    cwd,
    setReply(fn) {
      reply = fn;
    },
    async run() {
      await session.prompt("Continue.");
      await session.waitForIdle();
      assert.deepEqual(errors, []);
      return calls.at(-1);
    },
  };
}

const toolCall = (name, arguments_, id = name) => ({
  content: [{ type: "toolCall", id, name, arguments: arguments_ }], stopReason: "toolUse",
});
const goalSnapshot = h => {
  const request = { snapshot: undefined };
  h.bus.emit(METIS_EVENTS.goalSnapshot, request);
  return request.snapshot;
};
const systemText = call => getSystemMessageText(getCurrentSystemMessage(call.context.messages));

for (const reverse of [false, true])
test(`custom Goal creation and resume preserve goal and policy through tool steps, reverse=${reverse}`, { timeout: 15_000 }, async t => {
  const h = await host(t, false, reverse, false, { goal: true });
  h.setReply(count => count % 3 === 1
    ? toolCall("read", { path: join(h.cwd, "AGENTS.md") }, `goal-read-${count}`)
    : count % 3 === 2 ? toolCall("goal", { action: "update", status: "complete" }, `goal-complete-${count}`) : undefined);
  await h.session.prompt("/goal GOAL_LIFECYCLE_SENTINEL");
  await h.session.waitForIdle();
  assert.equal(h.calls.length, 3);
  assert.equal(goalSnapshot(h).status, "complete");
  await h.session.prompt("/goal pause");
  assert.equal(goalSnapshot(h).status, "paused");
  await h.session.prompt("/goal resume");
  await h.session.waitForIdle();
  assert.equal(h.calls.length, 6);
  assert.equal(goalSnapshot(h).status, "complete");
  for (const calls of [h.calls.slice(0, 3), h.calls.slice(3)]) {
    const prompt = systemText(calls[0]);
    assert.match(prompt, /POLICY_A_SENTINEL/);
    assert.doesNotMatch(prompt, /NATIVE_GLOBAL_SENTINEL/);
    assert.equal(prompt.split("GOAL_LIFECYCLE_SENTINEL").length - 1, 1);
    assert.ok(calls.every(call => systemText(call) === prompt), "Goal/policy prompt survives tool refresh");
    assert.match(JSON.stringify(calls[0].context), /Goal status: active/);
  }
  assert.match(JSON.stringify(h.calls[3].context), /Tokens used: 6/);
  assert.deepEqual(h.errors, []);
});

test("custom startup coalesces pending messages and consumes nextTurn exactly once", { timeout: 15_000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let starts = 0;
  const h = await host(t, false, false, false, { factories: [pi => {
    pi.on("before_agent_start", async (event, ctx) => {
      starts++;
      assert.equal(event.messageType, "custom");
      assert.equal(Object.hasOwn(event, "prompt"), false);
      assert.equal(ctx.isIdle(), false);
      if (starts === 1) { entered.resolve(); await release.promise; }
    });
  }] });
  await h.session.sendCustomMessage({ customType: "lifecycle-next", content: "NEXT_TURN_SENTINEL", display: false }, { deliverAs: "nextTurn" });
  const run = h.session.sendCustomMessage({ customType: "lifecycle-first", content: "FIRST_SENTINEL", display: false }, { triggerTurn: true });
  await entered.promise;
  const second = h.session.sendCustomMessage({ customType: "lifecycle-second", content: "SECOND_SENTINEL", display: false }, { triggerTurn: true });
  release.resolve();
  await Promise.all([run, second]);
  assert.equal(starts, 1);
  assert.equal(h.calls.length, 1);
  for (const text of ["FIRST_SENTINEL", "SECOND_SENTINEL", "NEXT_TURN_SENTINEL"])
    assert.match(JSON.stringify(h.calls[0].context), new RegExp(text));
  await h.session.sendCustomMessage({ customType: "lifecycle-later", content: "LATER_SENTINEL", display: false }, { triggerTurn: true });
  assert.equal(starts, 2);
  assert.equal(h.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "lifecycle-next").length, 1);
  assert.equal(JSON.stringify(h.calls[1].context).split("NEXT_TURN_SENTINEL").length - 1, 1);
  assert.deepEqual(h.errors, []);
});

test("aborting Goal startup prevents provider execution and pauses the non-UI Goal", { timeout: 15_000 }, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const events = [];
  const h = await host(t, false, false, false, { goal: true, factories: [pi => {
    pi.on("before_agent_start", async (_event, ctx) => {
      assert.equal(ctx.isIdle(), false);
      entered.resolve(); await release.promise;
    });
  }] });
  h.session.subscribe(event => {
    if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) events.push({
      type: event.type, aborted: event.aborted,
      stopReason: event.messages?.findLast(message => message.role === "assistant")?.stopReason,
    });
  });
  await h.session.prompt("/goal ABORT_STARTUP_SENTINEL");
  await entered.promise;
  const aborted = h.session.abort();
  release.resolve();
  await aborted;
  assert.equal(h.calls.length, 0);
  assert.equal(h.session.isIdle, true);
  assert.equal(goalSnapshot(h).status, "paused", JSON.stringify(events));
  assert.equal(h.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "goal-continuation").length, 1);
  assert.equal(h.session.agent.state.messages.filter(message => message.customType === "goal-continuation").length, 1);
  assert.deepEqual(h.errors, []);
});

test("internal checkpoint cancellation leaves Goal active for an explicit fresh retry", { timeout: 15_000 }, async t => {
  let cancelled = false;
  const h = await host(t, false, false, false, { goal: true, factories: [pi => {
    pi.on("context_with_system", (_event, ctx) => {
      if (cancelled) return;
      cancelled = true;
      pi.events.emit(METIS_EVENTS.checkpointRequestCancelled, {});
      ctx.abort();
    });
  }] });
  await h.session.prompt("/goal INTERNAL_CANCEL_SENTINEL");
  await h.session.waitForIdle();
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
  assert.equal(goalSnapshot(h).status, "active");
  assert.equal(h.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "goal-continuation").length, 1);
  h.setReply(count => count === 1 ? toolCall("goal", { action: "update", status: "complete" }) : undefined);
  await h.session.prompt("Explicit retry after internal cancellation.");
  assert.equal(h.calls.length, 2);
  assert.equal(goalSnapshot(h).status, "complete");
  assert.match(systemText(h.calls[0]), /INTERNAL_CANCEL_SENTINEL/);
  assert.deepEqual(h.errors, []);
});

for (const userInput of [false, true])
  test(`OCC continuation ticket ${userInput ? "yields to queued user input" : "resumes after settlement"}`, { timeout: 15_000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let maintenance = false;
    const h = await host(t, false, false, false, { goal: true, factories: [pi => {
      pi.events.on(METIS_EVENTS.occStatus, request => {
        if (!maintenance) request.deferGoal = true;
      });
      pi.on("agent_settled", async () => {
        if (maintenance) return;
        maintenance = true; entered.resolve(); await release.promise;
        pi.events.emit(METIS_EVENTS.occFinished, { cancelled: false });
      });
    }] });
    const finished = Promise.withResolvers();
    h.session.subscribe(event => {
      if (event.type === "agent_settled" && h.calls.length === (userInput ? 1 : 3)) finished.resolve();
    });
    h.setReply(count => count === 2 ? toolCall("goal", { action: "update", status: "complete" }) : undefined);
    await h.session.prompt("/goal OCC_TICKET_SENTINEL");
    await entered.promise;
    if (userInput) assert.equal(await h.session.followUp("USER_INPUT_SENTINEL"), "queued");
    release.resolve();
    await finished.promise;
    assert.equal(h.calls.length, userInput ? 1 : 3);
    assert.equal(goalSnapshot(h).status, userInput ? "active" : "complete");
    if (userInput) {
      assert.deepEqual(h.session.getFollowUpMessages(), ["USER_INPUT_SENTINEL"]);
      await h.session.prompt("USER_TAKEOVER_SENTINEL");
      assert.equal(goalSnapshot(h).status, "complete");
      assert.ok(h.calls.slice(1).some(call => JSON.stringify(call.context).includes("USER_INPUT_SENTINEL")), "queued input reaches the actual provider");
      assert.equal(h.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "goal-continuation").length, 1);
    } else assert.match(JSON.stringify(h.calls[1].context), /Goal status: active/);
    assert.deepEqual(h.errors, []);
  });

test("Metis web aggregation preserves curator approval within a run and resets on custom startup", { timeout: 15_000 }, async t => {
  const oldKey = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "offline";
  t.after(() => { if (oldKey === undefined) delete process.env.EXA_API_KEY; else process.env.EXA_API_KEY = oldKey; });
  const h = await host(t, false, false, false, { web: true, ui: true });
  const searches = [], phases = new Map(), submissions = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).hostname, "api.exa.ai", "all external calls must use the fake search endpoint");
    searches.push(JSON.parse(options.body).query);
    return Response.json({ results: [] });
  });
  const submitted = new Set();
  h.session.subscribe(event => {
    if (event.type !== "tool_execution_update") return;
    const details = event.partialResult.details;
    const seen = phases.get(event.toolCallId) ?? new Set();
    seen.add(details?.phase); phases.set(event.toolCallId, seen);
    if (details?.phase !== "curating" || !details.curatorUrl || submitted.has(event.toolCallId)) return;
    submitted.add(event.toolCallId);
    const url = new URL(details.curatorUrl);
    const submission = new Promise((resolve, reject) => {
      const req = httpRequest(new URL("/submit", url), { method: "POST", headers: { "content-type": "application/json" } }, response => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else reject(new Error(`curator submission returned ${response.statusCode}`));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ token: url.searchParams.get("session"), selected: [], summary: "Approved offline draft", autoApproveRemainingSearches: true }));
    });
    submissions.push(submission);
    void submission.catch(() => h.session.abort());
  });
  let initialRequests = 0, resetRequests = 0;
  h.setReply((_count, context) => {
    const text = JSON.stringify(context);
    const reset = text.includes("WEB_RESET_SENTINEL");
    if (!reset && !text.includes("WEB_START_SENTINEL")) return;
    const index = reset ? ++resetRequests : ++initialRequests;
    if (index > (reset ? 1 : 2)) return;
    const id = reset ? "curator-reset" : index === 1 ? "curator-first" : "curator-internal";
    return toolCall("web_access", { action: "search", params: { query: id, provider: "exa", proxy: "" } }, id);
  });
  h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "web_access"]);
  await h.session.sendCustomMessage({ customType: "web-lifecycle", content: "WEB_START_SENTINEL", display: false }, { triggerTurn: true });
  assert.ok(phases.get("curator-first")?.has("curating"), "approval runs through the bundled curator server");
  assert.ok(phases.get("curator-internal")?.has("generating-summary"), "same-run tool step inherits approval");
  assert.equal(submitted.has("curator-internal"), false);
  await h.session.sendCustomMessage({ customType: "web-lifecycle", content: "WEB_RESET_SENTINEL", display: false }, { triggerTurn: true });
  await Promise.all(submissions);
  assert.ok(phases.get("curator-reset")?.has("curating"), "new custom run requires fresh approval");
  assert.equal(submitted.size, 2);
  assert.deepEqual(searches, ["curator-first", "curator-internal", "curator-reset"]);
  assert.equal(h.session.getAllTools().some(tool => tool.name === "web_enable"), false);
  assert.equal(h.session.getActiveToolNames().includes("web_enable"), false);
  assert.deepEqual(h.errors, []);
});

for (const [converted, reverse] of [
  [false, false],
  [true, false],
  [true, true],
])
  test(`run-boundary replacement preserves sources and project rules, converted=${converted}, reverse=${reverse}`, async (t) => {
    const h = await host(t, converted, reverse);
    const stateEntries = () =>
      h.sm.getBranch().filter((e) => e.type === "custom" && e.customType === "metis-dynamic-agents");
    await h.session.setModel(h.model("b"));
    await h.session.setModel(h.model("a"));
    assert.equal(stateEntries().length, 0);
    assert.equal(h.calls.length, 0);
    const first = await h.run();
    assert.match(JSON.stringify(first.context), /POLICY_A_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(first.context), /NATIVE_GLOBAL_SENTINEL|POLICY_B_SENTINEL/);
    const oldEntries = h.sm.getEntries().map((e) => ({ id: e.id, text: JSON.stringify(e) }));
    const diskPrefix = readFileSync(h.sm.getSessionFile(), "utf8");
    await h.session.setModel(h.model("b"));
    const second = await h.run();
    assert.match(JSON.stringify(second.context), /POLICY_B_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(second.context), /POLICY_A_SENTINEL|NATIVE_GLOBAL_SENTINEL/);
    assert.match(JSON.stringify(second.context), /PROJECT_SENTINEL/);
    for (const entry of oldEntries)
      assert.equal(JSON.stringify(h.sm.getEntries().find((e) => e.id === entry.id)), entry.text);
    assert.ok(readFileSync(h.sm.getSessionFile(), "utf8").startsWith(diskPrefix));
    if (converted) {
      const body = await captureBody(second.model, second.context, {
        onPayload: (body) => h.session.extensionRunner.emitBeforeProviderRequest(body),
      });
      assert.match(JSON.stringify(body), /POLICY_B_SENTINEL/);
      assert.doesNotMatch(JSON.stringify(body), /POLICY_A_SENTINEL|NATIVE_GLOBAL_SENTINEL/);
      assert.match(JSON.stringify(body), /PROJECT_SENTINEL/);
    }
    await h.session.setModel(h.model("a"));
    const third = await h.run();
    assert.match(JSON.stringify(third.context), /POLICY_A_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(third.context), /POLICY_B_SENTINEL/);
    await h.session.setModel(h.model("other"));
    const fallback = await h.run();
    assert.match(JSON.stringify(fallback.context), /NATIVE_GLOBAL_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(fallback.context), /POLICY_[AB]_SENTINEL/);
    assert.equal(readFileSync(join(h.agentDir, "AGENTS.md"), "utf8"), "NATIVE_GLOBAL_SENTINEL");
    assert.equal(readFileSync(join(h.agentDir, "A.md"), "utf8"), "POLICY_A_SENTINEL");
  });

test("policy is frozen across tool steps and refreshes only at the next run", async (t) => {
  const h = await host(t, false);
  h.setReply((count) => {
    if (count !== 1) return;
    writeFileSync(join(h.agentDir, "A.md"), "POLICY_UPDATED_SENTINEL");
    return {
      content: [{ type: "toolCall", id: "read-project", name: "read", arguments: { path: join(h.cwd, "AGENTS.md") } }],
      stopReason: "toolUse",
    };
  });
  await h.run();
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.match(JSON.stringify(call.context), /POLICY_A_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(call.context), /POLICY_UPDATED_SENTINEL/);
  }
  const next = JSON.stringify((await h.run()).context);
  assert.match(next, /POLICY_UPDATED_SENTINEL/);
  assert.doesNotMatch(next, /POLICY_A_SENTINEL/);
});

for (const converted of [false, true])
  test(`global file edits refresh next run without reload, converted=${converted}`, async (t) => {
    const h = await host(t, converted);
    await h.session.setModel(h.model("other"));
    h.setReply((count) => {
      if (count !== 1) return;
      writeFileSync(join(h.agentDir, "AGENTS.md"), "UPDATED_GLOBAL_SENTINEL");
      return {
        content: [
          { type: "toolCall", id: "read-project", name: "read", arguments: { path: join(h.cwd, "AGENTS.md") } },
        ],
        stopReason: "toolUse",
      };
    });
    await h.run();
    assert.equal(h.calls.length, 2);
    for (const call of h.calls) {
      assert.match(JSON.stringify(call.context), /NATIVE_GLOBAL_SENTINEL/);
      assert.doesNotMatch(JSON.stringify(call.context), /UPDATED_GLOBAL_SENTINEL/);
    }
    const updated = await h.run();
    const body = converted
      ? await captureBody(updated.model, updated.context, {
          onPayload: (body) => h.session.extensionRunner.emitBeforeProviderRequest(body),
        })
      : updated.context;
    assert.match(JSON.stringify(body), /UPDATED_GLOBAL_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(body), /NATIVE_GLOBAL_SENTINEL/);
    assert.match(JSON.stringify(body), /PROJECT_SENTINEL/);
    writeFileSync(join(h.agentDir, "AGENTS.override.md"), "OVERRIDE_GLOBAL_SENTINEL");
    assert.match(JSON.stringify((await h.run()).context), /OVERRIDE_GLOBAL_SENTINEL/);
    rmSync(join(h.agentDir, "AGENTS.override.md"));
    assert.match(JSON.stringify((await h.run()).context), /UPDATED_GLOBAL_SENTINEL/);
    rmSync(join(h.agentDir, "AGENTS.md"));
    const removed = JSON.stringify((await h.run()).context);
    assert.doesNotMatch(removed, /(?:UPDATED|OVERRIDE|NATIVE)_GLOBAL_SENTINEL/);
    assert.match(removed, /PROJECT_SENTINEL/);
    writeFileSync(join(h.agentDir, "AGENTS.md"), "RECREATED_GLOBAL_SENTINEL");
    assert.match(JSON.stringify((await h.run()).context), /RECREATED_GLOBAL_SENTINEL/);
  });

test("editing an inactive policy affects only the next run that selects it", async t => {
  const h = await host(t, false);
  await h.run();
  writeFileSync(join(h.agentDir, "B.md"), "UPDATED_B_SENTINEL");
  const unchanged = JSON.stringify((await h.run()).context);
  assert.match(unchanged, /POLICY_A_SENTINEL/); assert.doesNotMatch(unchanged, /UPDATED_B_SENTINEL/);
  await h.session.setModel(h.model("b"));
  const selected = JSON.stringify((await h.run()).context);
  assert.match(selected, /UPDATED_B_SENTINEL/); assert.doesNotMatch(selected, /POLICY_[AB]_SENTINEL/);
});

test("bad config, disabling, and reload restore native rules without inheriting the last policy", async t => {
  const h = await host(t, false);
  await h.run();
  writeFileSync(join(h.agentDir, "metis-pi.toml"), "[broken");
  assert.match(JSON.stringify((await h.run()).context), /NATIVE_GLOBAL_SENTINEL/);
  writeFileSync(join(h.agentDir, "metis-pi.toml"), stringify({ dynamicAgents: { ...h.config, enabled: true } }));
  assert.match(JSON.stringify((await h.run()).context), /POLICY_A_SENTINEL/);
  writeFileSync(join(h.agentDir, "metis-pi.toml"), stringify({ dynamicAgents: { ...h.config, enabled: true, groups: [h.config.groups[1]] } }));
  await h.session.setModel(h.model("b"));
  await h.session.reload();
  const restored = JSON.stringify((await h.run()).context);
  assert.match(restored, /POLICY_B_SENTINEL/); assert.doesNotMatch(restored, /POLICY_A_SENTINEL/);
  writeFileSync(join(h.agentDir, "metis-pi.toml"), stringify({ dynamicAgents: { ...h.config, enabled: false } }));
  const result = JSON.stringify((await h.run()).context);
  assert.match(result, /NATIVE_GLOBAL_SENTINEL/); assert.doesNotMatch(result, /POLICY_[AB]_SENTINEL/);
});

test("whole package retains tools and applies dynamic policy", async t => {
  const h = await host(t, false, false, true);
  const call = await h.run();
  const body = JSON.stringify(call.context);
  assert.match(body, /POLICY_A_SENTINEL/); assert.match(body, /PROJECT_SENTINEL/);
  assert.doesNotMatch(body, /NATIVE_GLOBAL_SENTINEL/);
  const names = h.session.getActiveToolNames();
  for (const name of ["read", "write", "goal", "lsp"]) assert.ok(names.includes(name), name);
  assert.equal(h.session.getAllTools().find(tool => tool.name === "context_tree_query")?.exposure, "deferred");
  assert.equal(names.includes("context_tree_query"), false);
});
