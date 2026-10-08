import assert from "node:assert/strict";
import { registerOcc } from "../../src/condense/occ.ts";
import { DEFAULT_CONFIG } from "../../src/condense/types.ts";
import { TokenEstimator } from "../../src/condense/token-estimator.ts";
import { detectChains } from "../../src/condense/chain-detector.ts";
import { findCompressibleRange } from "../../src/condense/chain-compressor.ts";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const usage = { input: 75000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 75010,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function host(t, { summary = "Derived progress: investigation continues.", onSummary, goal = false, edit, workTurns = 0, beforeLoad, auto = false, onWork, localSummary = false, requirement = "ORIGINAL_GOAL: inspect only; do not deploy", compactionOverrides = {}, autoAfterLocal = false, pruneOn = "agent-message", pruneOverrides = {}, captureNotices = false } = {}) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work", "occ-host-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const installed = process.env.METIS_OCC_INSTALLED_PROFILE;
  const installedSettings = installed ? JSON.parse(readFileSync(join(installed, "settings.json"), "utf8")) : {};
  if (installed) installedSettings.packages = installedSettings.packages.map(source => resolve(installed, source));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...installedSettings, contextPrune: {
    enabled: true, opportunisticCompaction: true, minBatchChars: 5000, pruneOn,
    // Isolate native/OCC ownership unless this fixture explicitly supplies a
    // local-summary provider; the shipped pressure default now admits it.
    autoBudgetThreshold: localSummary ? 0.7 : null,
    spillThreshold: 1000000, chainCompression: { enabled: false }, purgeErrors: { enabled: false },
    ...pruneOverrides,
  } }));
  const sm = SessionManager.create(dir, dir);
  const compaction = { enabled: auto && !autoAfterLocal, reserveTokens: 500, keepRecentTokens: 1000, ...compactionOverrides };
  {
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...settings, compaction }));
  }
  const settingsManager = SettingsManager.create(dir, dir);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  const model = { id: "occ-local", name: "OCC local", provider: "occ-local", api: "openai-completions",
    baseUrl: "http://invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const calls = [], errors = [], notices = [];
  if (localSummary) {
    const stream = (m, context) => {
      calls.push({ summarizing: true, local: true, context });
      const out = createAssistantMessageEventStream();
      const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
        content: [{ type: "text", text: localSummary === "dense" ? "a".repeat(7200)
          : "[[1:read]] Inspection complete; consult the archive for exact evidence." }],
        stopReason: "stop", timestamp: Date.now(), usage };
      Promise.resolve().then(async () => {
        if (autoAfterLocal) { settingsManager.setCompactionEnabled(true); await settingsManager.flush(); }
        out.push({ type: "done", reason: "stop", message }); out.end(message);
      }).catch(error => out.end({ ...message, stopReason: "error", errorMessage: String(error) }));
      return out;
    };
    registerApiProvider({ api: model.api, stream, streamSimple: stream }, "occ-test-local-summary");
    t.after(() => unregisterApiProviders("occ-test-local-summary"));
  }
  let actualWork = 0;
  const workEvidence = index => localSummary === "dense" ? `NEW_WORK_EVIDENCE_${index}\n` + "界".repeat(6000)
    : `NEW_WORK_EVIDENCE_${index} `.repeat(localSummary ? 800 : 350);
  writeFileSync(join(dir, "work.txt"), workEvidence(0));
  modelRuntime.registerProvider("occ-local", {
    api: model.api, apiKey: "local", baseUrl: model.baseUrl, models: [model],
    streamSimple(m, context, options) {
      const out = createAssistantMessageEventStream();
      const summarizing = !JSON.stringify(context).includes("OCC_TEST");
      calls.push({ summarizing, context, maxTokens: options?.maxTokens });
      Promise.resolve().then(async () => {
        const summaryResponse = summarizing ? await onSummary?.({ sm, options }) : undefined;
        const toolUse = !summarizing && actualWork++ < workTurns;
        if (toolUse) writeFileSync(join(dir, "work.txt"), workEvidence(actualWork));
        const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
          content: toolUse ? [{ type: "toolCall", id: `work-${actualWork}`, name: "read", arguments: { path: join(dir, "work.txt") } }]
            : [{ type: "text", text: summarizing ? summary : "Final response." }],
          stopReason: options?.signal?.aborted ? "aborted" : toolUse ? "toolUse" : "stop", timestamp: Date.now(), usage };
        if (!summarizing) Object.assign(message, await onWork?.({ sm, toolUse, index: calls.filter(c => !c.summarizing).length }));
        else if (summaryResponse) Object.assign(message, summaryResponse);
        out.push({ type: "done", reason: message.stopReason, message }); out.end(message);
      }).catch(error => out.end({ role: "assistant", api: m.api, provider: m.provider, model: m.id,
        content: [], stopReason: "error", errorMessage: String(error), timestamp: Date.now(), usage }));
      return out;
    },
  });
  // A large completed source range plus a separate kept turn creates a real
  // native compaction boundary, not a fabricated before_compact preparation.
  sm.appendMessage({ role: "user", content: requirement, timestamp: 1 });
  sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [
    { type: "toolCall", id: "evidence", name: "read", arguments: { path: "old.log" } },
  ], stopReason: "toolUse", timestamp: 2, usage });
  sm.appendMessage({ role: "toolResult", toolCallId: "evidence", toolName: "read", isError: false,
    content: [{ type: "text", text: "EXACT_EVIDENCE\n" + "source-body ".repeat(14000) }], timestamp: 3 });
  sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "text", text: "Completed source inspection." }], stopReason: "stop", timestamp: 4, usage });
  if (!workTurns) sm.appendCustomEntry("metis-occ-state", { phase: "waiting", work: 5, atWork: 4, atChars: 0,
    recentGrowth: [100, 100, 100, 100] });
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
    additionalExtensionPaths: installed ? [] : [join(root, "extensions/condense.ts"), join(root, "extensions/execution.ts"), ...(goal ? [join(root, "extensions/goal.ts")] : [])],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "OCC_TEST" });
  await resourceLoader.reload();
  const loaded = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader, sessionManager: sm, model });
  t.after(async () => {
    try { await loaded.session.extensionRunner.emit({ type: "session_shutdown" }); assert.deepEqual(errors, []); }
    finally { loaded.session.dispose(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
  });
  assert.deepEqual(loaded.extensionsResult.errors, []);
  if (installed) {
    const expectedRoot = resolve(installedSettings.packages[0]);
    assert.ok(loaded.extensionsResult.extensions.some(extension => extension.path === join(expectedRoot, "extensions/condense.ts")));
    assert.ok(loaded.extensionsResult.extensions.every(extension => extension.path.startsWith(expectedRoot + "/")));
  }
  await loaded.session.bindExtensions({ onError: e => errors.push(e), ...(captureNotices ? {
    mode: "rpc", uiContext: { notify: (message, type) => notices.push({ message, type }), setStatus() {}, setWidget() {} },
  } : {}) });
  const events = [];
  loaded.session.subscribe(event => {
    if (event.type === "compaction_start" || event.type === "compaction_end") events.push(event);
  });
  return { ...loaded, sm, calls, errors, notices, eventBus, events, settingsManager };
}

for (const enabled of [false, true]) {
  test(`real SDK manual chain compression with automation ${enabled ? "on" : "off"} reports only incremental tokens`, async t => {
    const h = await host(t, {
      captureNotices: true, workTurns: 1, localSummary: true, pruneOn: "on-demand",
      pruneOverrides: { opportunisticCompaction: false, autoBudgetThreshold: null, minBatchChars: 0,
        chainCompression: { enabled, rollingWindow: 999, fuseRangeSummary: false } },
      beforeLoad(sm) {
        sm.getBranch().find(e => e.message?.role === "assistant").message.content.unshift({
          type: "thinking", thinking: "prior detailed source reasoning ".repeat(500),
        });
      },
    });
    await h.session.prompt("Continue inspection. " + "RECENT_WORK ".repeat(500));
    await h.session.prompt("/pruner now");
    assert.ok(h.sm.getBranch().some(e => e.customType === "context-prune-summary"));
    assert.ok(!h.sm.getBranch().some(e => e.customType === "context-prune-chain"), "rolling window prevents automatic scheduling");
    const project = () => {
      const request = { sessionId: h.sm.getSessionId(), api: h.session.model.api,
        messages: h.sm.buildSessionProjection().messages };
      h.eventBus.emit("metis:condense-project", request);
      return request.messages;
    };
    const raw = h.sm.buildSessionProjection().messages;
    assert.ok(detectChains(raw).some(chain => findCompressibleRange(chain, raw)));
    const before = project();
    const callsBefore = h.calls.length;
    await h.session.prompt("/pruner compact");
    const after = project();
    assert.ok(h.sm.getBranch().some(e => e.customType === "context-prune-chain"));
    assert.ok(after.some(message => message.metisDerived?.kind === "condense-chain"));
    assert.equal(h.calls.length, callsBefore, "manual compaction reuses archived summaries without another model request");
    const counter = new TokenEstimator();
    let counts;
    try { counts = await counter.measure(before, after); } finally { counter.clear(); }
    assert.ok(counts && counts.before > counts.after);
    const notice = h.notices.find(({ message }) => /compacted \d+ chain.*reclaimed/.test(message));
    assert.ok(notice, "valid explicit work must not be announced as no eligible chains");
    const reported = Number(notice.message.match(/reclaimed ~(\d+) tokens/)[1]);
    assert.equal(reported, counts.before - counts.after, "do not recount the already-pruned archived outputs");
    assert.match(notice.message, /local incremental estimate/);
    await h.session.extensionRunner.emit({ type: "session_start" });
    assert.deepEqual(project(), after, "committed manual ranges still project after runtime reload");
    await h.session.prompt("/pruner off");
    assert.ok(!project().some(message => message.metisDerived?.kind === "condense-chain"), "the global switch remains authoritative");
    await h.session.prompt("/pruner on");
    assert.deepEqual(project(), after);
    const source = h.sm.getBranch().find(e => e.message?.toolCallId === "evidence");
    h.sm.appendContextEdit(source.id, { content: [{ type: "text", text: "CORRECTED_MANUAL_EVIDENCE" }] });
    assert.match(JSON.stringify(project()), /CORRECTED_MANUAL_EVIDENCE/, "a manual range cannot hide edited source evidence");
  });
}

for (const [limit, expected] of [[0, 400], [64, 64], [2048, 400]]) {
  test(`native manual summary ceiling ${limit} preserves Pi limits, previous summary and ordinary requests`, async t => {
    const h = await host(t, { pruneOverrides: { enabled: false, opportunisticCompaction: false, compactionSummaryMaxTokens: limit } });
    await h.session.prompt("Continue real inspection work. " + "RECENT_WORK ".repeat(500)); await h.session.waitForIdle();
    await h.session.compact("Keep exact file paths.");
    assert.equal(h.calls.find(c => c.summarizing).maxTokens, expected);
    assert.match(JSON.stringify(h.calls.find(c => c.summarizing).context), /Keep exact file paths/);
    assert.equal(h.settingsManager.getCompactionSettings(h.session.model).reserveTokens, 500);
    await h.session.prompt("Continue real inspection work. " + "RECENT_WORK ".repeat(500)); await h.session.waitForIdle();
    assert.equal(h.calls.find(c => !c.summarizing).maxTokens, undefined);
    await h.session.compact();
    assert.match(JSON.stringify(h.calls.filter(c => c.summarizing).at(-1).context), /Derived progress: investigation continues/);
    assert.ok(h.calls.filter(c => c.summarizing).every(c => c.maxTokens <= expected));
  });
}

for (const reason of ["threshold", "overflow"]) {
  test(`native ${reason} summary ceiling works with pruning and OCC off`, async t => {
    const h = await host(t, { auto: true, pruneOverrides: { enabled: false, opportunisticCompaction: false, compactionSummaryMaxTokens: 64 },
      onWork: ({ index }) => reason === "overflow" && index === 1
        ? { stopReason: "error", errorMessage: "maximum context length exceeded", content: [] }
        : { usage: pressureUsage(index === 1 ? 99900 : 50000) } });
    await h.session.prompt("Inspect the remaining evidence."); await h.session.waitForIdle();
    assert.deepEqual(compactionReasons(h), [reason]);
    assert.ok(h.calls.filter(c => c.summarizing).length > 0);
    assert.ok(h.calls.filter(c => c.summarizing).every(c => c.maxTokens <= 64));
    assert.equal(h.settingsManager.getCompactionSettings(h.session.model).reserveTokens, 500);
  });
}

test("custom native summary ceiling makes OCC use the same bounded output for costs, headroom and generation", async t => {
  const h = await host(t, { auto: true, compactionOverrides: { reserveTokens: 600000 },
    pruneOverrides: { compactionSummaryMaxTokens: 8192 },
    beforeLoad(_sm, model) { model.contextWindow = 1000000; model.maxTokens = 131072; },
    onWork: () => ({ usage: pressureUsage(288000) }) });
  await h.session.prompt("Continue inspection without deploying."); await h.session.waitForIdle();
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => c.maxTokens), [8192]);
  const decision = h.sm.getBranch().find(e => e.customType === "metis-occ-decision" && e.data.reason === "accepted").data;
  assert.equal(decision.estimatedAfterChars, decision.protectedChars + 4 * 8192);
  assert.equal(decision.economics.summaryOutputUpperBound, 8192);
  assert.equal(h.settingsManager.getCompactionSettings(h.session.model).reserveTokens, 600000);
  assert.match(compactions(h)[0].summary, /ORIGINAL_GOAL/);
});

test("a capped native summary ending at length does not publish a partial checkpoint", async t => {
  const h = await host(t, { pruneOverrides: { enabled: false, opportunisticCompaction: false, compactionSummaryMaxTokens: 64 },
    onSummary: () => ({ stopReason: "length", content: [{ type: "text", text: "Incomplete summary" }] }) });
  const before = h.sm.buildSessionProjection();
  await assert.rejects(h.session.compact(), /token cap/);
  assert.equal(compactions(h).length, 0);
  assert.deepEqual(h.sm.buildSessionProjection(), before);
  assert.equal(h.calls.find(c => c.summarizing).maxTokens, 40, "Pi keeps its smaller split-turn budget within the configured ceiling");
});

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
  assert.match(JSON.stringify(h.calls.find(c => c.summarizing).context), /Aim for at most 16384 output text tokens/);
  assert.equal(h.calls.find(c => c.summarizing).maxTokens, 400, "soft target does not alter Pi's hard generation ceiling");
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
});

for (const prices of [undefined, { input: 1000000, output: 1000000000, cacheRead: 0.001, cacheWrite: 1000000 }]) {
  test(`OCC relative-cost policy ignores provider tariff metadata: ${prices ? "channel markup" : "missing"}`, async t => {
    const h = await host(t, { beforeLoad(_sm, model) { model.cost = prices; } });
    await h.session.prompt("Continue real inspection work."); await h.session.waitForIdle();
    assert.equal(h.calls.filter(c => c.summarizing).length, 1);
    const decision = h.sm.getBranch().find(e => e.customType === "metis-occ-decision" && e.data.reason === "accepted").data;
    assert.deepEqual(decision.economics.weights, { input: 1, output: 5, cacheRead: 0.1 });
    assert.ok(decision.economics.reusableRequests > decision.economics.breakEvenRequests);
  });
}

for (const growth of [undefined, [2240, 2240, 2240, 2240]]) {
  test(`OCC avoids speculative summary calls when growth is ${growth ? "too fast to amortize" : "unobserved"}`, async t => {
    const h = await host(t, { pruneOn: "on-demand", beforeLoad(sm) {
      sm.getBranch().find(e => e.customType === "metis-occ-state").data.recentGrowth = growth;
    } });
    await h.session.prompt("Continue inspection."); await h.session.waitForIdle();
    assert.equal(h.calls.filter(c => c.summarizing).length, 0);
    const decision = h.sm.getBranch().find(e => e.customType === "metis-occ-decision")?.data;
    if (growth) {
      assert.equal(decision.reason, "insufficient-estimated-savings");
      assert.ok(decision.economics.reusableRequests <= decision.economics.breakEvenRequests);
    }
    await h.session.compact();
    assert.equal(h.calls.filter(c => c.summarizing).length, 1, "manual compaction remains available");
    assert.match(h.sm.getBranch().find(e => e.type === "compaction").summary, /ORIGINAL_GOAL/);
  });
}

for (const blocked of ["archiveFailed", "unfinished"]) test(`OCC preserves unavailable native nested evidence: ${blocked}`, async t => {
  const h = await host(t, { beforeLoad(sm, model) {
    const result = sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult").message;
    sm.appendMessage({ role: "assistant", ...model, model: model.id, timestamp: 5, stopReason: "toolUse", usage,
      content: [{ type: "toolCall", id: "native-parent", name: "codemode", arguments: { code: "text(1)" } }] });
    sm.appendMessage({ ...result, toolCallId: "native-parent", toolName: "codemode", timestamp: 6,
      content: [{ type: "text", text: "Nested evidence unavailable" }], details: { metisNested: { [blocked]: true } } });

  } });
  await h.session.prompt("Continue inspecting; preserve evidence."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 0, JSON.stringify({ notices: h.notices,
    state: h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1)?.data }));
  assert.equal(h.sm.getBranch().filter(e => e.type === "compaction").length, 0);
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
});

for (const outcome of ["accepted", "paused", "aborted", "growing"]) test(`goal continuation observes OCC outcome: ${outcome}`, async t => {
  let h;
  h = await host(t, { goal: true,
    summary: outcome === "growing" ? "too large ".repeat(25000) : "Derived progress: investigation continues.",
    onSummary: () => outcome === "paused" ? h.session.prompt("/goal pause")
      : outcome === "aborted" ? h.session.abortCompaction() : undefined,
  });
  await h.session.prompt("Start bounded work.");
  await h.session.waitForIdle();
  const entries = h.sm.getBranch();
  const continues = outcome === "accepted" || outcome === "growing";
  assert.equal(entries.filter(e => e.type === "compaction").length, outcome === "accepted" || outcome === "paused" ? 1 : 0);
  assert.equal(h.calls.filter(c => !c.summarizing).length, continues ? 2 : 1);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(entries.filter(e => e.type === "custom_message" && e.customType === "goal-continuation").length, continues ? 1 : 0);
  assert.equal(entries.some(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message).includes("__continue_")), false);
  if (outcome === "paused") assert.equal(entries.filter(e => e.type === "custom" && e.customType === "goal").at(-1).data.goal.status, "paused");
  if (outcome === "aborted") assert.match(JSON.stringify(h.sm.buildSessionProjection().messages), /EXACT_EVIDENCE/);
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
});


const pressureUsage = input => ({ ...usage, input, totalTokens: input + usage.output });
const compactionReasons = h => h.events.filter(e => e.type === "compaction_start").map(e => e.reason);
const compactions = h => h.sm.getEntries().filter(e => e.type === "compaction");

for (const goal of [false, true]) test(`cancelling native threshold before preparation does not restart OCC or goal; goal=${goal}`, async t => {
  const h = await host(t, { auto: true, goal, onWork: () => ({ usage: pressureUsage(99900) }) });
  h.session.subscribe(event => {
    if (event.type === "compaction_start" && event.reason === "threshold") h.session.abortCompaction();
  });
  await h.session.prompt("Continue bounded work."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["threshold"]);
  assert.equal(h.calls.length, 1, "neither a summary nor an owed goal continuation runs after cancellation");
  assert.equal(compactions(h).length, 0);
  assert.equal(h.events.at(-1).aborted, true);
});

test("native early safety rejection consumes the ready OCC boundary without another attempt", async t => {
  const h = await host(t, { auto: true, requirement: "C".repeat(650000), onWork: () => ({ usage: pressureUsage(99900) }) });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["threshold"]);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(compactions(h).length, 0);
});

for (const oversized of [false, true]) test(`native threshold completes its boundary without settled OCC; oversized=${oversized}`, async t => {
  const h = await host(t, { auto: true, summary: oversized ? "too large ".repeat(25000) : "Bounded summary.",
    onWork: () => ({ usage: pressureUsage(99900) }) });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["threshold"]);
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(compactions(h).length, oversized ? 0 : 1);
});

// Enabling auto-compaction while a local summary is in flight remains a valid
// stale-usage boundary even though the new buffer prevents starting it there.
test("local condense defers a stale threshold but fresh high usage still permits capacity compaction", async t => {
  const h = await host(t, { auto: true, workTurns: 4, localSummary: true, autoAfterLocal: true,
    beforeLoad(sm) { sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).message.content[0].text = "Historical reasoning. ".repeat(1000); },
    onWork: ({ toolUse }) => ({ usage: pressureUsage(toolUse ? 61000 : 99900) }) });
  await h.session.prompt("Do four inspections and finish."); await h.session.waitForIdle();
  // Default turn batching commits the historical read and four new reads separately.
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => Boolean(c.local)), [true, true, true, true, true]);
  assert.equal(compactions(h).length, 0);
  assert.deepEqual(compactionReasons(h), ["threshold"]);
  // Pre-prompt checks still see the old usage, but a new actual request clears
  // the publication credit. Its high provider usage must not be suppressed.
  await h.session.prompt("Continue with a fresh response."); await h.session.waitForIdle();
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => Boolean(c.local)), [true, true, true, true, true, false]);
  assert.equal(compactions(h).length, 1);
});

test("local proxy gains do not suppress native pressure when Pi estimates no useful reduction", async t => {
  // Dense source tokens and a longer ASCII summary satisfy the o200k budget,
  // but cannot earn Pi/native capacity credit merely by passing that check.
  const h = await host(t, { auto: true, workTurns: 4, localSummary: "dense", autoAfterLocal: true,
    // Leave most history outside condense's eligible tool output. Less than
    // the required headroom is recovered, despite publishing a local summary.
    beforeLoad(sm) {
      sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult").message.content[0].text = "small evidence";
      sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).message.content[0].text = "Historical reasoning. ".repeat(1000);
    },
    onWork: ({ toolUse }) => ({ usage: pressureUsage(toolUse ? 61000 : 99900) }) });
  await h.session.prompt("Do four inspections and finish."); await h.session.waitForIdle();
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => Boolean(c.local)), [true, true, true, true, false]);
  assert.equal(compactions(h).length, 1);
});

test("explicit overflow still attempts capacity rescue immediately after OCC", async t => {
  const h = await host(t, { onWork: ({ index }) => index === 3
    ? { stopReason: "error", errorMessage: "maximum context length exceeded", content: [] } : undefined });
  await h.session.prompt("Continue bounded work."); await h.session.waitForIdle();
  const held = h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data;
  assert.equal(held.work - held.atWork, 0);
  h.session.setAutoCompactionEnabled(true);
  await h.session.sendCustomMessage({ customType: "new-evidence", content: "NEW_EVIDENCE ".repeat(12000), display: false }, { triggerTurn: false });
  await h.session.prompt("Record new evidence."); await h.session.waitForIdle();
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["manual", "overflow"]);
});


test("a later context edit already accounted for by Pi receives no duplicate local reduction credit", async t => {
  const h = await host(t, { auto: true, workTurns: 4, localSummary: true, autoAfterLocal: true,
    beforeLoad(sm) { sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).message.content[0].text = "Historical reasoning. ".repeat(25000); },
    onWork: ({ toolUse }) => ({ usage: pressureUsage(toolUse ? 61000 : 99900) }) });
  const target = h.sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).id;
  const emit = h.session.extensionRunner.emit.bind(h.session.extensionRunner);
  h.session.extensionRunner.emit = async event => {
    const result = await emit(event);
    if (event.type === "agent_end") h.sm.appendContextEdit(target, {
      content: [{ type: "text", text: "Revised reasoning. ".repeat(24000) }],
    });
    return result;
  };
  await h.session.prompt("Do four inspections and finish."); await h.session.waitForIdle();
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => Boolean(c.local)), [true, true, true, true, true, false]);
  assert.equal(compactions(h).length, 1);
});


test("an idle manual cancellation does not cancel a later user request's goal continuation", async t => {
  const h = await host(t, { auto: true, goal: true, workTurns: 5,
    beforeLoad(sm) {
      sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult").message.content[0].text = "source-body ".repeat(10000);
      sm.getBranch().find(e => e.type === "custom" && e.customType === "goal").data.goal.tokenBudget = 450000;
    },
    onWork: ({ toolUse, index }) => ({ usage: pressureUsage(toolUse ? 61000 : index > 6 ? 60000 : 99900) }) });
  const unsubscribe = h.session.subscribe(event => {
    if (event.type === "compaction_start" && event.reason === "manual") h.session.abortCompaction();
  });
  await assert.rejects(h.session.compact());
  unsubscribe();
  await h.session.prompt("Start the new bounded task."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => !c.summarizing).length, 7, "five work calls, final answer and one owed continuation");
  assert.equal(compactions(h).length, 1);
});


test("native safety rejection preserves an owed goal continuation", async t => {
  const h = await host(t, { auto: true, goal: true, requirement: "C".repeat(650000),
    onWork: () => ({ usage: pressureUsage(99900) }) });
  await h.session.prompt("Continue the bounded goal."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => !c.summarizing).length, 2);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(compactions(h).length, 0);
  assert.ok(compactionReasons(h).every(reason => reason === "threshold"), "safe rejection must not start OCC");
});

test("real overflow after local condense bypasses stale-threshold deferral", async t => {
  const h = await host(t, { auto: true, workTurns: 4, localSummary: true, autoAfterLocal: true,
    beforeLoad(sm) { sm.getBranch().filter(e => e.type === "message" && e.message.role === "assistant").at(-1).message.content[0].text = "Historical reasoning. ".repeat(1000); },
    onWork: ({ toolUse }) => ({ usage: pressureUsage(toolUse ? 61000 : 101000) }) });
  await h.session.prompt("Do four inspections and finish."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["overflow"]);
  assert.deepEqual(h.calls.filter(c => c.summarizing).map(c => Boolean(c.local)), [true, true, true, true, true, false]);
  assert.equal(compactions(h).length, 1);
});


for (const goal of [false, true]) test(`capacity buffer skips ready OCC without spending its quota or stalling goal; goal=${goal}`, async t => {
  const h = await host(t, { auto: true, goal, onWork: () => ({ usage: pressureUsage(95000) }) });
  await h.session.prompt("Continue bounded work."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(h.calls.filter(c => !c.summarizing).length, goal ? 2 : 1);
  assert.deepEqual(compactionReasons(h), []);
  const state = h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data;
  assert.equal(!!state.capacityWaiting, false, "below native threshold does not claim capacity takeover");
  assert.equal(state.spentRequest, undefined);
});

test("near native capacity allows local summaries while skipping economic OCC", async t => {
  const h = await host(t, { auto: true, workTurns: 1, localSummary: true,
    onWork: () => ({ usage: pressureUsage(95000) }) });
  await h.session.prompt("Inspect and finish."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 2);
  assert.ok(h.sm.getEntries().some(e => e.type === "custom_message" && e.customType === "context-prune-summary"));
  assert.deepEqual(compactionReasons(h), []);
  assert.match(JSON.stringify(h.sm.getEntries()), /NEW_WORK_EVIDENCE/, "raw evidence remains recoverable");
});

test("native capacity uses strict greater-than after reload, including the exact threshold", async t => {
  const h = await host(t, { auto: true, onWork: ({ index }) => ({ usage: pressureUsage([95000, 99000, 99500 - usage.output][index - 1]) }) });
  const state = () => h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data;
  await h.session.prompt("First."); await h.session.waitForIdle();
  assert.equal(!!state().capacityWaiting, false);
  await h.session.extensionRunner.emit({ type: "session_start" });
  await h.session.prompt("Second."); await h.session.waitForIdle();
  assert.equal(!!state().capacityWaiting, false);
  await h.session.prompt("Third."); await h.session.waitForIdle();
  assert.equal(!!state().capacityWaiting, false, "the exact threshold remains eligible for local pruning");
  assert.equal(state().spentRequest, undefined);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
});

for (const reserve of [500, 16000]) test(`capacity buffer resolves the active model reserve override; reserve=${reserve}`, async t => {
  const h = await host(t, { auto: true, compactionOverrides: { modelOverrides: { "occ-local/occ-local": { reserveTokens: reserve } } },
    onWork: () => ({ usage: pressureUsage(80000) }) });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, reserve === 500 ? 1 : 0);
});

test("disabling auto-compaction releases its buffer and leaves OCC available", async t => {
  const h = await host(t, { auto: true, onWork: () => ({ usage: pressureUsage(95000) }) });
  await h.session.prompt("First."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  h.session.setAutoCompactionEnabled(false); await h.settingsManager.flush();
  // Restore an earned OCC boundary to isolate availability from work counters.
  h.sm.appendCustomEntry("metis-occ-state", { phase: "waiting", work: 5, atWork: 4, atChars: 0, capacityWaiting: true });
  await h.session.extensionRunner.emit({ type: "session_start" });
  await h.session.prompt("Auto-compaction is disabled; continue."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metis-occ-state").at(-1).data.capacityWaiting, false);
});

test("disabled auto-compaction does not impose its near-capacity exclusion on OCC", async t => {
  const h = await host(t, { auto: false, onWork: () => ({ usage: pressureUsage(95000) }) });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
});

test("OCC rejects before generation when the whole retained context lacks two buffers of headroom", async t => {
  const h = await host(t, { auto: true, onWork: () => ({ usage: pressureUsage(93000) }),
    beforeLoad(sm) { sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult").message.content[0].text = "data".repeat(1500); } });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.deepEqual(compactionReasons(h), ["manual"]);
  assert.equal(h.calls.filter(c => c.summarizing).length, 0);
  assert.equal(compactions(h).length, 0);
});

test("OCC rechecks whole-context headroom after generating the candidate", async t => {
  // Pi retains the system/tool table: counting it as freed history admits this candidate.
  const h = await host(t, { auto: true, summary: "S".repeat(32000), onWork: () => ({ usage: pressureUsage(94000) }),
    beforeLoad(sm) { sm.getBranch().find(e => e.type === "message" && e.message.role === "toolResult").message.content[0].text = "sourcebody".repeat(5000); } });
  await h.session.prompt("Continue."); await h.session.waitForIdle();
  assert.equal(h.calls.filter(c => c.summarizing).length, 1);
  assert.equal(compactions(h).length, 0, JSON.stringify(compactions(h).map(c => ({ before: c.tokensBefore, summary: c.summary.length, protected: c.details.metisOcc.protectedChars }))));
});


test("successive native compactions flatten protected sources and retain exact historical entry recall", async t => {
  let model;
  const h = await host(t, { beforeLoad(_sm, m) { model = m; } });
  await h.session.prompt("Continue inspecting without deployment.");
  await h.session.waitForIdle();
  const first = compactions(h)[0];
  assert.ok(first.details.metisOcc.protection);
  for (let round = 1; round <= 2; round++) {
    h.sm.appendMessage({ role: "user", content: `CORRECTION_${round}: keep this constraint`, timestamp: 100 + round * 10 });
    h.sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "toolCall", id: `next-${round}`, name: "read", arguments: { path: `round-${round}.log` } }], stopReason: "toolUse", usage, timestamp: 101 + round * 10 });
    h.sm.appendMessage({ role: "toolResult", toolCallId: `next-${round}`, toolName: "read", isError: false, content: [{ type: "text", text: "NEW_SOURCE ".repeat(16000) }], timestamp: 102 + round * 10 });
    h.sm.appendMessage({ role: "assistant", ...model, model: model.id, content: [{ type: "text", text: "Round complete" }], stopReason: "stop", usage, timestamp: 103 + round * 10 });
    await h.session.compact();
    const latest = compactions(h).at(-1);
    assert.equal(latest.details.metisOcc.protection.format, "metis-occ-protected-v2");
    assert.equal(latest.summary.split("[Program-retained sources]").length, 2, "one flat envelope");
    assert.match(latest.summary, /ORIGINAL_GOAL/);
    assert.match(latest.summary, new RegExp(`CORRECTION_${round}`));
    assert.equal(latest.details.metisOcc.protection.legacy.length, 0);
    assert.ok(latest.details.metisOcc.protection.history.length);
  }
  assert.equal(compactions(h).length, 3);
  for (const call of h.calls.filter(c => c.summarizing)) assert.doesNotMatch(JSON.stringify(call.context), /Program-retained sources|Derived progress: investigation continues/);
  const query = h.session.extensionRunner.getAllRegisteredTools().find(t => t.definition.name === "context_tree_query").definition;
  const result = await query.execute("q", { sourceEntryIds: [first.id] }, undefined, undefined, { sessionManager: h.sm });
  assert.equal(JSON.parse(result.details.results[0].text).summary, first.summary);
});


for (const exhaustWait of [false, true]) test(`OCC follows Pi's compaction limit and can become ready after waiting expires; exhausted=${exhaustWait}`, async t => {
  const dir = mkdtempSync(join(root, ".work", "occ-limit-")), old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: true, reserveTokens: 32768,
    modelOverrides: { "local/large-window": { reserveTokens: 600000 } } } }));
  const branch = [{ type: "message", id: "request", message: { role: "user" } },
    { type: "custom", customType: "metis-occ-state", data: { phase: "normal", work: 4, atWork: 0, atChars: 0, recentGrowth: [100, 100, 100, 100] } }];
  const hooks = new Map(); let tokens = 239999, compactions = 0;
  const ctx = { cwd: dir, model: { provider: "local", id: "large-window", contextWindow: 1000000 },
    sessionManager: { getSessionId: () => "limit-test", getBranch: () => branch, getEntries: () => branch,
      buildSessionProjection: () => ({ messages: [], entries: [] }) },
    getContextUsage: () => ({ tokens, contextWindow: 1000000 }), isIdle: () => true, hasPendingMessages: () => false,
    compact({ onComplete }) { compactions++; onComplete(); }, ui: { setStatus() {} } };
  const occ = registerOcc({ on(name, fn) { hooks.set(name, fn); }, events: { emit() {}, on() { return () => {}; } },
    appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); } }, {},
    { value: { ...DEFAULT_CONFIG, enabled: true, opportunisticCompaction: true } });
  t.after(() => occ.shutdown(ctx)); occ.restore(ctx);
  assert.equal(occ.deferLocal(ctx), false, "below 60% of the 400k native trigger");
  tokens = 240000; assert.equal(occ.deferLocal(ctx), true, "wait at 240k, not 600k");
  for (let i = 0; i < (exhaustWait ? 3 : 1); i++) {
    hooks.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse", timestamp: i,
      content: [{ type: "toolCall", id: `work-${i}`, name: "read", arguments: { path: `work-${i}.txt` } }] },
      toolResults: [{ role: "toolResult", toolCallId: `work-${i}`, toolName: "read", isError: false, timestamp: i + 1,
        content: [{ type: "text", text: "distinct successful work" }] }] }, ctx);
    tokens = 244964 + i * 1960; occ.deferLocal(ctx);
  }
  if (exhaustWait) {
    assert.equal(occ.deferLocal(ctx), false, "expired waiting releases local summaries within the same request");
    occ.restore(ctx);
    assert.equal(occ.deferLocal(ctx), false, "reload does not restart waiting below the readiness threshold");
  }
  tokens = 287999; occ.deferLocal(ctx); await hooks.get("agent_settled")({}, ctx);
  assert.equal(compactions, 0, "below 72% is not ready");
  tokens = 288000; occ.deferLocal(ctx); await hooks.get("agent_settled")({}, ctx);
  assert.equal(compactions, 1, "ready at 288k, not 720k");
  await hooks.get("agent_settled")({}, ctx);
  assert.equal(compactions, 1, "repeated idle boundaries do not repeat the summary attempt");
});

test("OCC work ignores recall, polling, failures and repeated identical observations", () => {
  const hooks = new Map(), states = [];
  registerOcc({ on(name, fn) { hooks.set(name, fn); }, events: { on() { return () => {}; } }, appendEntry(_kind, data) { states.push(data); } }, {},
    { value: { ...DEFAULT_CONFIG, enabled: true, opportunisticCompaction: true } });
  const observe = (id, name, isError, text) => hooks.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse", timestamp: id,
    content: [{ type: "toolCall", id: String(id), name, arguments: { path: "same.txt" } }] },
    toolResults: [{ role: "toolResult", toolCallId: String(id), toolName: name, isError, timestamp: id + 1, content: [{ type: "text", text }] }] }, {});
  for (let i = 0; i < 4; i++) observe(i, "context_tree_query", true, "missing");
  observe(10, "write_stdin", false, "still running");
  observe(11, "read", true, "missing");
  assert.equal(states.length, 0);
  for (let i = 20; i < 24; i++) observe(i, "read", false, "unchanged evidence");
  assert.equal(states.at(-1).work, 1);
  observe(30, "read", false, "new evidence");
  assert.equal(states.at(-1).work, 2);
});
