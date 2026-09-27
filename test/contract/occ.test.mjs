import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = { input: 75000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 75010,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function host(t, { summary = "Derived progress: investigation continues.", onSummary, goal = false, edit, workTurns = 0, beforeLoad } = {}) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work", "occ-host-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const installed = process.env.METIS_OCC_INSTALLED_PROFILE;
  const installedSettings = installed ? JSON.parse(readFileSync(join(installed, "settings.json"), "utf8")) : {};
  if (installed) installedSettings.packages = installedSettings.packages.map(source => resolve(installed, source));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...installedSettings, contextPrune: {
    enabled: true, opportunisticCompaction: true, minBatchChars: 5000,
    spillThreshold: 1000000, chainCompression: { enabled: false }, purgeErrors: { enabled: false },
  } }));
  const sm = SessionManager.create(dir, dir);
  const compaction = { enabled: false, reserveTokens: 500, keepRecentTokens: 1000 };
  if (installed) {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...settings, compaction }));
  }
  const settingsManager = installed ? SettingsManager.create(dir, dir) : SettingsManager.inMemory({ compaction });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const model = { id: "occ-local", name: "OCC local", provider: "occ-local", api: "openai-completions",
    baseUrl: "http://invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const calls = [], errors = [], notices = [];
  let actualWork = 0;
  writeFileSync(join(dir, "work.txt"), "NEW_WORK_EVIDENCE ".repeat(350));
  modelRuntime.registerProvider("occ-local", {
    api: model.api, apiKey: "local", baseUrl: model.baseUrl, models: [model],
    streamSimple(m, context, options) {
      const out = createAssistantMessageEventStream();
      const summarizing = !JSON.stringify(context).includes("OCC_TEST");
      calls.push({ summarizing, context });
      Promise.resolve().then(async () => {
        if (summarizing) await onSummary?.({ sm, options });
        const toolUse = !summarizing && actualWork++ < workTurns;
        const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
          content: toolUse ? [{ type: "toolCall", id: `work-${actualWork}`, name: "read", arguments: { path: join(dir, "work.txt") } }]
            : [{ type: "text", text: summarizing ? summary : "Final response." }],
          stopReason: options?.signal?.aborted ? "aborted" : toolUse ? "toolUse" : "stop", timestamp: Date.now(), usage };
        out.push({ type: "done", reason: message.stopReason, message }); out.end(message);
      }).catch(error => out.end({ role: "assistant", api: m.api, provider: m.provider, model: m.id,
        content: [], stopReason: "error", errorMessage: String(error), timestamp: Date.now(), usage }));
      return out;
    },
  });
  // A large completed source range plus a separate kept turn creates a real
  // native compaction boundary, not a fabricated before_compact preparation.
  sm.appendMessage({ role: "user", content: "ORIGINAL_GOAL: inspect only; do not deploy", timestamp: 1 });
  sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [
    { type: "toolCall", id: "evidence", name: "read", arguments: { path: "old.log" } },
  ], stopReason: "toolUse", timestamp: 2, usage });
  sm.appendMessage({ role: "toolResult", toolCallId: "evidence", toolName: "read", isError: false,
    content: [{ type: "text", text: "EXACT_EVIDENCE\n" + "source-body ".repeat(14000) }], timestamp: 3 });
  sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "text", text: "Completed source inspection." }], stopReason: "stop", timestamp: 4, usage });
  if (!workTurns) sm.appendCustomEntry("metis-occ-state", { phase: "waiting", work: 5, atWork: 4, atChars: 0 });
  if (edit) {
    const target = sm.getBranch().find(e => e.type === "message" && e.message.role === "user");
    sm.appendContextEdit(target.id, edit === "remove" ? null : { content: edit });
  }
  if (goal) {
    sm.appendCustomEntry("goal", { version: 2, action: "set", goal: {
      id: "occ-test-goal", objective: "GOAL_OBJECTIVE: inspect without deploying", status: "active",
      tokenBudget: 150020, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    } });
  }
  beforeLoad?.(sm, model);
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({ eventBus, cwd: dir, agentDir: dir, settingsManager,
    additionalExtensionPaths: installed ? [] : [join(root, "extensions/condense.ts"), join(root, "vendor/pi-codex-conversion/dist/index.js"), ...(goal ? [join(root, "extensions/goal.ts")] : [])],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "OCC_TEST" });
  await resourceLoader.reload();
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader, sessionManager: sm, model });
  t.after(async () => {
    try { await loaded.session.extensionRunner.emit({ type: "session_shutdown" }); }
    finally { loaded.session.dispose(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
  });
  assert.deepEqual(loaded.extensionsResult.errors, []);
  if (installed) {
    assert.equal(loaded.extensionsResult.extensions.length, 8);
    assert.ok(loaded.extensionsResult.extensions.every(extension => extension.path.startsWith(root)));
  }
  await loaded.session.bindExtensions({ onError: e => errors.push(e) });
  return { ...loaded, sm, calls, errors, notices, eventBus };
}

test("real AgentSession automatically commits OCC once, protects source requirements and recalls exact evidence", async t => {
  const h = await host(t);
  await h.session.prompt("Continue inspecting; preserve evidence and do not deploy.");
  await h.session.waitForIdle();
  const entries = h.sm.getBranch();
  const compacted = entries.filter(e => e.type === "compaction");
  assert.equal(compacted.length, 1, JSON.stringify({ notices: h.notices, errors: h.errors, calls: h.calls.map(c => c.summarizing) }));
  assert.match(compacted[0].summary, /ORIGINAL_GOAL: inspect only; do not deploy/);
  assert.match(compacted[0].summary, /context_tree_query/);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  const query = h.session.extensionRunner.getAllRegisteredTools().find(t => t.definition.name === "context_tree_query").definition;
  const ctx = { sessionManager: h.sm };
  const directory = await query.execute("list", {}, undefined, undefined, ctx);
  assert.match(directory.content[0].text, /evidence@3/);
  const recalled = await query.execute("read", { toolCallIds: ["evidence@3"], maxBytes: 2048 }, undefined, undefined, ctx);
  assert.match(recalled.details.results[0].text, /^EXACT_EVIDENCE/);
  const snapshot = JSON.stringify(h.sm.buildSessionProjection().messages);
  await h.session.prompt("Continue without rewriting history.");
  await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
  assert.deepEqual(h.sm.buildSessionProjection().messages[0], JSON.parse(snapshot)[0]);
  assert.deepEqual(h.errors, []);
});

test("a rejected growing summary never commits and consumes the OCC attempt across reload", async t => {
  const h = await host(t, { summary: "oversized ".repeat(25000) });
  await h.session.prompt("Continue.");
  await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
  await h.session.extensionRunner.emit({ type: "session_start" });
  await h.session.prompt("Continue again.");
  await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.deepEqual(h.errors, []);
});


test("effective context edits replace source requirements before OCC and in the next provider payload", async t => {
  const h = await host(t, { edit: "CORRECTED_GOAL: inspect only staging" });
  await h.session.prompt("Continue.");
  await h.session.waitForIdle();
  const entry = h.sm.getBranch().find(e => e.type === "compaction");
  assert.ok(entry);
  assert.match(entry.summary, /CORRECTED_GOAL: inspect only staging/);
  assert.doesNotMatch(entry.summary, /ORIGINAL_GOAL/);
  await h.session.prompt("Continue.");
  assert.doesNotMatch(JSON.stringify(h.calls.at(-1).context), /ORIGINAL_GOAL/);
  assert.deepEqual(h.errors, []);
});

test("accepted source mutation during summary invalidates the candidate before native commit", async t => {
  const h = await host(t, { onSummary: ({ sm }) => {
    const user = sm.getBranch().find(e => e.type === "message" && e.message.role === "user");
    sm.appendContextEdit(user.id, { content: "CHANGED_DURING_SUMMARY" });
  } });
  await h.session.prompt("Continue.");
  await h.session.waitForIdle();
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
  assert.match(JSON.stringify(h.sm.buildSessionProjection().messages), /CHANGED_DURING_SUMMARY/);
  assert.deepEqual(h.errors, []);
});

test("active goal yields for OCC and resumes exactly once with its existing continuation", async t => {
  const h = await host(t, { goal: true });
  await h.session.prompt("Start bounded work.");
  await h.session.waitForIdle();
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
  assert.equal(h.calls.filter(c => !c.summarizing).length, 2);
  assert.equal(h.sm.getBranch().filter(e => e.type === "custom_message" && e.customType === "goal-continuation").length, 1);
  assert.equal(h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user").some(e => JSON.stringify(e.message).includes("__continue_")), false);
  assert.deepEqual(h.errors, []);
});

test("pause queued during OCC wins over the old goal continuation ticket", async t => {
  let h;
  h = await host(t, { goal: true, onSummary: () => h.session.prompt("/goal pause") });
  await h.session.prompt("Start bounded work.");
  await h.session.waitForIdle();
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
  assert.equal(h.calls.filter(c => !c.summarizing).length, 1);
  const goal = h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "goal").at(-1).data.goal;
  assert.equal(goal.status, "paused");
  assert.deepEqual(h.errors, []);
});

test("user abort during OCC drops the owed goal continuation and preserves raw context", async t => {
  let h;
  h = await host(t, { goal: true, onSummary: () => h.session.abortCompaction() });
  await h.session.prompt("Start bounded work.");
  await h.session.waitForIdle();
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
  assert.equal(h.calls.filter(c => !c.summarizing).length, 1);
  assert.deepEqual(h.errors, []);
});


test("safe OCC rejection resumes an active goal instead of treating it as user cancellation", async t => {
  const h = await host(t, { goal: true, summary: "too large ".repeat(25000) });
  await h.session.prompt("Start bounded work.");
  await h.session.waitForIdle();
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
  assert.equal(h.calls.filter(c => !c.summarizing).length, 2);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.deepEqual(h.errors, []);
});


test("fresh automatic mode earns its buffer from real tool requests before one global rewrite", async t => {
  const h = await host(t, { workTurns: 4 });
  await h.session.prompt("Inspect the working evidence through tools.");
  await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => !c.summarizing).length, 5);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 1);
  const state = h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data;
  assert.equal(state.work, 4);
  assert.equal(state.phase, "hold");
  assert.deepEqual(h.errors, []);
});

test("held outgoing provider prefix preserves a recovery page after its old grace expires", async t => {
  const page = "RECALLED_PAGE_KEEP_EXACT ".repeat(300);
  const h = await host(t, { beforeLoad(sm, model) {
    sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [
      { type: "toolCall", id: "review-query", name: "context_tree_query", arguments: { toolCallIds: ["evidence@3"] } },
    ], stopReason: "toolUse", timestamp: 5, usage });
    sm.appendMessage({ role: "toolResult", toolCallId: "review-query", toolName: "context_tree_query", isError: false,
      content: [{ type: "text", text: page }], timestamp: 6 });
    sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "text", text: "Read evidence." }], stopReason: "stop", timestamp: 7, usage });
    sm.appendCustomEntry("context-prune-index", { toolCalls: [{
      toolCallId: "review-query", toolName: "context_tree_query", args: { toolCallIds: ["evidence@3"] },
      resultText: page, resultTimestamp: 6, isError: false, turnIndex: 2, timestamp: 5,
    }] });
    sm.appendCustomEntry("metis-occ-state", { phase: "hold", work: 5, atWork: 5, atChars: 180000 });
  } });
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await h.session.prompt(`Follow-up ${i}: continue.`);
    await h.session.waitForIdle();
    const messages = h.calls.filter(c => !c.summarizing).at(-1).context.messages;
    seen.push(messages.find(m => m.toolCallId === "review-query").content[0].text);
  }
  const state = h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data;
  assert.equal(state.phase, "hold");
  assert.equal(state.work - state.atWork, 0);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(seen[3], seen[0]);
});

test("edits to indexed evidence reject in-flight OCC and remain visible in the next provider payload", async t => {
  const correction = "CORRECTED_CURRENT_EVIDENCE";
  const h = await host(t, { beforeLoad(sm, model) {
    const result = sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult");
    sm.appendCustomEntry("context-prune-index", { toolCalls: [{
      toolCallId: "evidence", toolName: "read", args: { path: "old.log" }, resultText: result.message.content[0].text,
      resultTimestamp: 3, isError: false, turnIndex: 0, timestamp: 2,
    }] });
    sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [
      { type: "toolCall", id: "bulk", name: "read", arguments: { path: "bulk.log" } },
    ], stopReason: "toolUse", timestamp: 5, usage });
    sm.appendMessage({ role: "toolResult", toolCallId: "bulk", toolName: "read", isError: false,
      content: [{ type: "text", text: "OTHER_UNINDEXED_EVIDENCE ".repeat(14000) }], timestamp: 6 });
    sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "text", text: "Bulk captured." }], stopReason: "stop", timestamp: 7, usage });
  }, onSummary: ({ sm }) => {
    const target = sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === "evidence");
    sm.appendContextEdit(target.id, { content: correction });
  } });
  await h.session.prompt("Continue.");
  await h.session.waitForIdle();
  const entries = h.sm.getBranch();
  const compactions = entries.filter(e => e.type === "compaction");
  const edits = entries.filter(e => e.type === "context_edit");
  assert.equal(edits.length, 1);
  assert.match(JSON.stringify(h.sm.buildSessionProjection().messages), /CORRECTED_CURRENT_EVIDENCE/);
  await h.session.prompt("Use the corrected evidence.");
  assert.match(JSON.stringify(h.calls.filter(c => !c.summarizing).at(-1).context), /CORRECTED_CURRENT_EVIDENCE/);
  assert.deepEqual(h.errors, []);
  assert.equal(compactions.length, 0, "an accepted tool source edit must reject the frozen candidate");
});

test("branch navigation cannot replenish the same external request OCC quota", async t => {
  const h = await host(t);
  await h.session.prompt("Continue the current investigation.");
  await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  const firstRequest = h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1).id;
  const target = h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).id;
  await h.session.navigateTree(target);
  await h.session.sendCustomMessage({ customType: "review-continuation", content: "Continue the same request.", display: false }, { triggerTurn: true });
  await h.session.waitForIdle();
  const currentRequest = h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1).id;
  assert.equal(firstRequest, currentRequest);
  assert.equal(h.sm.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.deepEqual(h.errors, []);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
});


test("edited archived evidence removes its stale derived summary and preserves the summary's whole source group", async t => {
  const h = await host(t, { beforeLoad(sm, model) {
    const evidence = sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult");
    sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [
      { type: "toolCall", id: "partner", name: "read", arguments: { path: "partner.log" } },
    ], stopReason: "toolUse", timestamp: 5, usage });
    sm.appendMessage({ role: "toolResult", toolCallId: "partner", toolName: "read", isError: false,
      content: [{ type: "text", text: "PARTNER_EXACT_BODY" }], timestamp: 6 });
    sm.appendCustomEntry("context-prune-index", { toolCalls: [
      { toolCallId: "evidence", toolName: "read", args: {}, resultText: evidence.message.content[0].text, resultTimestamp: 3, isError: false, turnIndex: 0, timestamp: 2 },
      { toolCallId: "partner", toolName: "read", args: {}, resultText: "PARTNER_EXACT_BODY", resultTimestamp: 6, isError: false, turnIndex: 2, timestamp: 5 },
    ] });
    sm.appendCustomMessageEntry("context-prune-summary", "STALE_DERIVED_CLAIM", false, { toolCallRefs: [
      { shortId: "t1", toolCallId: "evidence", resultTimestamp: 3 }, { shortId: "t2", toolCallId: "partner", resultTimestamp: 6 },
    ] });
    sm.appendContextEdit(evidence.id, { content: [{ type: "text", text: "CORRECTED_BODY" }] });
    sm.appendCustomEntry("metis-occ-state", { phase: "hold", work: 5, atWork: 5, atChars: 180000 });
  } });
  await h.session.prompt("Use only corrected evidence.");
  await h.session.waitForIdle();
  const payload = JSON.stringify(h.calls.filter(c => !c.summarizing).at(-1).context);
  assert.match(payload, /CORRECTED_BODY/);
  assert.match(payload, /PARTNER_EXACT_BODY/);
  assert.doesNotMatch(payload, /STALE_DERIVED_CLAIM/);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.deepEqual(h.errors, []);
});
