import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { RewriteBudget } from "../../src/condense/rewrite-policy.ts";
import { TokenEstimator } from "../../src/condense/token-estimator.ts";
import { summaryGroupMembers } from "../../src/condense/summary-refs.ts";
import { prepareSharedChain } from "../../src/condense/chain-compressor.ts";
import { detectChains } from "../../src/condense/chain-detector.ts";
import { ToolCallIndexer } from "../../src/condense/indexer.ts";
import { BlockRefIssuer } from "../../src/condense/block-refs.ts";
import { chainMembers } from "../../src/condense/chain-model.ts";
import { applyChainCompressions } from "../../src/condense/chain-range-prune.ts";
import { METIS_EVENTS } from "../../src/collaboration.ts";
import { disableNetwork } from "../helpers/native-provider.mjs";
import { fixture, usage } from "../helpers/condense-pipeline.mjs";

test.beforeEach(disableNetwork);
const summaryUsage = { ...usage, input: 13624, output: 200, totalTokens: 13824 };
const baseRates = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const highRates = { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 };
const coldRates = { input: 2, output: 0, cacheRead: 2, cacheWrite: 2.6 };
const codeText = tokens => {
  const line = "value_0123456789 = 0xabcdef123456;\n";
  return line.repeat(Math.ceil(tokens * 4 / line.length)).slice(0, tokens * 4);
};
const summaries = f => f.sm.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "context-prune-summary");
function projection(f) {
  const request = { sessionId: f.ctx.sessionManager.getSessionId(), api: f.ctx.model.api,
    messages: f.ctx.sessionManager.buildSessionProjection().messages };
  f.events.emit(METIS_EVENTS.condenseProject, request);
  return request.messages;
}
async function groupFixture(t, { mainRates, contextTokens = 403650, windowTokens = 500000, ...options } = {}) {
  const f = await fixture(t, { batchingMode: "turn", summarizerThinking: "low", summarizerFallbackModels: [], summaryUsage,
    reply: n => `Independent evidence ${n}.`, spillThreshold: 0,
    chainCompression: { ...DEFAULT_CONFIG.chainCompression, enabled: false, fuseRangeSummary: false }, ...options });
  Object.assign(f.ctx.model, { id: "cached-main", reasoning: true, contextWindow: windowTokens,
    maxTokens: Math.min(90000, Math.floor(windowTokens / 4)), cost: structuredClone(mainRates ?? baseRates),
    priceTiers: mainRates ? undefined : [{ after: 0, cost: baseRates }, { after: 272000, cost: highRates }], pricing: "pi" });
  const cheap = f.ctx.modelRegistry.find();
  Object.assign(cheap, { reasoning: true, contextWindow: 1048576, maxTokens: 393216,
    cost: { input: 0.04, output: 0.08, cacheRead: 0.0016, cacheWrite: 0 }, pricing: "pi" });
  f.ctx.modelRegistry.find = (provider, id) => provider !== "local" ? undefined
    : id === "cheap-summary" ? cheap : id === "cached-main" ? f.ctx.model : undefined;
  f.ctx.getContextUsage = () => ({ tokens: contextTokens, contextWindow: windowTokens });
  f.primaryUsage = { ...usage, input: Math.min(8000, Math.round(contextTokens * 0.02)),
    cacheRead: contextTokens - Math.min(8000, Math.round(contextTokens * 0.02)) };
  await f.emit("model_select", { model: f.ctx.model }); await f.waitMaintenance();
  return f;
}
async function history(f, { prefix = 318000, oldTokens = 12900, tail = 0, oldCount = 4,
  oldBody = codeText(oldTokens), command = "inspect-source" } = {}) {
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: codeText(prefix) }],
    stopReason: "stop", timestamp: f.nextTimestamp() });
  const old = [];
  for (let i = 0; i < oldCount; i++) {
    f.sm.appendMessage({ role: "user", content: `Old task ${i}`, timestamp: f.nextTimestamp() });
    const call = f.add(oldBody, command, `old-${i}`);
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `Old result ${i}` }],
      stopReason: "stop", timestamp: f.nextTimestamp() });
    await f.emit("turn_end", { message: call.assistant, toolResults: [call.result], turnIndex: i });
    old.push(call);
  }
  f.sm.appendMessage({ role: "user", content: "Continue the active investigation", timestamp: f.nextTimestamp() });
  const active = Array.from({ length: 4 }, (_, i) => f.add(codeText(8300), "inspect-source", `active-${i}`));
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: codeText(tail) || "Active checkpoint" }],
    stopReason: "stop", timestamp: f.nextTimestamp() });
  return { old, active };
}
async function checkpoint(f) { return f.finish(true, f.primaryUsage); }
async function warmUntilAttempt(f, reached = () => f.calls.length > 0) {
  let message;
  for (let i = 0; i < 4; i++) {
    message = await checkpoint(f);
    if (reached()) break;
  }
  return message;
}
async function recall(f, id) {
  let cursor, text = "", pages = 0;
  do {
    const result = await f.tools.get("context_tree_query").execute("group-recall", { toolCallIds: [id], cursor },
      undefined, undefined, f.ctx);
    assert.equal(result.isError, false);
    for (const page of result.details.results) { assert.equal(page.offsetBytes, Buffer.byteLength(text)); text += page.text; }
    cursor = result.details.nextCursor;
    assert.ok(++pages <= 24, "exact recall must terminate");
  } while (cursor);
  return text;
}
function assertRaw(f, calls) {
  const visible = projection(f);
  for (const call of calls) assert.deepEqual(visible.find(message => message.toolCallId === call.id), call.result);
}
function failPublication(t, f) {
  const append = f.sm.appendCustomMessageEntry.bind(f.sm);
  let writes = 0;
  t.mock.method(f.sm, "appendCustomMessageEntry", (...args) => {
    if (args[0] === "context-prune-summary" && ++writes === 1) throw new Error("SUMMARY_GROUP_WRITE_FAILURE");
    return append(...args);
  });
  return () => writes;
}

test("economical short-context groups publish once and retain protected work, independent bodies and exact recall", async t => {
  const published = t.mock.method(RewriteBudget.prototype, "published");
  const f = await groupFixture(t, { windowTokens: 100000, contextTokens: 84000 });
  const { old, active } = await history(f, { prefix: 18000, oldTokens: 8000 });
  await warmUntilAttempt(f);
  assert.equal(f.calls.length, 3);
  assert.equal(summaries(f).length, 1);
  assert.equal(summaryGroupMembers({ content: summaries(f)[0].content, details: summaries(f)[0].details }).length, 3);
  assert.equal(published.mock.callCount(), 1, "a group shares one cold-rewrite liability");
  assert.ok(published.mock.calls[0].arguments[0] < 100000);
  assert.ok(published.mock.calls[0].arguments[1] > 20000);
  assertRaw(f, active.concat(old[0]));
  for (const call of old.slice(1)) assert.equal(await recall(f, call.id), call.result.content[0].text);
  const before = projection(f);
  f.ctx.sessionManager = SessionManager.open(f.sm.getSessionFile(), f.dir);
  await f.emit("session_start"); await f.waitMaintenance();
  assert.deepEqual(projection(f), before);
  assert.equal(f.calls.length, 3);
});

test("paid group failures retain all source and fees without retrying the same persisted checkpoint", async t => {
  for (const failure of ["publication", "final-gate", "generation"]) await t.test(failure, async t => {
    const settled = [], reserve = RewriteBudget.prototype.reserveFee;
    t.mock.method(RewriteBudget.prototype, "reserveFee", function (cost) {
      const settle = reserve.call(this, cost);
      return actual => { settled.push(actual); return settle(actual); };
    });
    const f = await groupFixture(t, failure === "final-gate"
      ? { reply: "x".repeat(23600), summaryUsage: { ...summaryUsage, output: 3000, totalTokens: 16624 } }
      : failure === "generation" ? { stopReason: n => n === 1 ? "stop" : "error", mainRates: coldRates, contextTokens: 350000 } : {});
    const { old, active } = await history(f, failure === "generation" ? { prefix: 100000, tail: 166000 } : {});
    const writes = failure === "publication" ? failPublication(t, f) : undefined;
    const message = await warmUntilAttempt(f);
    assert.equal(f.calls.length, 3);
    if (writes) assert.equal(writes(), 1);
    assert.equal(summaries(f).length, 0);
    assertRaw(f, old.concat(active));
    assert.equal(settled.length, 3);
    assert.ok(settled.every(fee => fee > 0), "failed generation/publication does not write off request fees");
    await f.emit("message_end", { message }); await f.waitMaintenance();
    assert.equal(f.calls.length, 3, "saving the triggering checkpoint does not create new work");
    if (failure === "final-gate") assert.ok(settled.every(fee => Math.abs(fee - 784.96) < 1e-6));
  });
});

test("fresh group recovery suppresses old spending but reopens for work, pricing and same-id endpoint changes", async t => {
  const first = await groupFixture(t, { mainRates: coldRates, contextTokens: 350000 });
  await history(first, { prefix: 100000, tail: 166000 });
  const writes = failPublication(t, first);
  const message = await warmUntilAttempt(first);
  assert.equal(first.calls.length, 3); assert.equal(writes(), 1);
  const snapshot = readFileSync(first.sm.getSessionFile(), "utf8");
  await first.emit("session_shutdown");
  for (const change of ["none", "without-memo", "work", "price", "endpoint"]) await t.test(change, async t => {
    const file = join(first.dir, `${change}.jsonl`);
    writeFileSync(file, change === "without-memo" ? snapshot.replaceAll("context-prune-group-attempt", "ignored-group-attempt") : snapshot);
    const f = await groupFixture(t, { sessionFile: file, mainRates: coldRates, contextTokens: 350000 });
    if (change === "work") {
      f.sm.appendMessage({ role: "user", content: "New investigation work", timestamp: f.nextTimestamp() });
      await checkpoint(f);
    } else {
      const cheap = f.ctx.modelRegistry.find("local", "cheap-summary");
      if (change === "price") cheap.cost = { ...cheap.cost, input: 0.02, output: 0.04 };
      if (change === "endpoint") cheap.baseUrl = "http://another.invalid";
      await f.emit("model_select", { model: f.ctx.model }); await f.waitMaintenance();
      await f.emit("message_end", { message }); await f.waitMaintenance();
    }
    assert.equal(f.calls.length, change === "none" ? 0 : 3);
    assert.equal(summaries(f).length, change === "none" ? 0 : 1);
  });
});

test("group fallback prices the actual route and refuses an unaffordable remaining group before expensive calls", async t => {
  for (const multiplier of [1, 3]) await t.test(`fallback rate x${multiplier}`, async t => {
    const f = await groupFixture(t, { summarizerFallbackModels: ["local/fallback"], stopReason: n => n === 1 ? "error" : "stop" });
    const cheap = f.ctx.modelRegistry.find("local", "cheap-summary"), find = f.ctx.modelRegistry.find;
    const fallback = { ...cheap, id: "fallback", reasoning: false,
      cost: { input: multiplier, output: 2 * multiplier, cacheRead: 0.01, cacheWrite: 0 } };
    f.ctx.modelRegistry.find = (provider, id) => provider === "local" && id === "fallback" ? fallback : find(provider, id);
    f.ctx.modelRegistry.getAll = () => [f.ctx.model, cheap, fallback];
    const used = [], stream = f.ctx.modelRegistry.streamSimple;
    f.ctx.modelRegistry.streamSimple = (model, ...args) => { used.push(model.id); return stream(model, ...args); };
    await f.emit("model_select", { model: f.ctx.model }); await f.waitMaintenance();
    const { old, active } = await history(f);
    const message = await warmUntilAttempt(f);
    assert.deepEqual(used, multiplier === 1 ? ["cheap-summary", "fallback", "fallback", "fallback"] : ["cheap-summary"]);
    assert.deepEqual(f.requests.map(request => request.maxTokens), multiplier === 1 ? [14336, 12288, 12288, 12288] : [14336]);
    assert.equal(summaries(f).length, multiplier === 1 ? 1 : 0);
    if (multiplier > 1) assertRaw(f, old.concat(active));
    await f.emit("message_end", { message }); await f.waitMaintenance();
    assert.equal(f.calls.length, multiplier === 1 ? 4 : 1);
  });
});

test("groups cannot bypass pressure, packing, request count or preflight economics", async t => {
  for (const kind of ["pressure", "packing", "two-batches", "expensive"]) await t.test(kind, async t => {
    const f = await groupFixture(t, kind === "pressure" ? { autoBudgetThreshold: null } : {});
    if (kind === "expensive") {
      f.ctx.modelRegistry.find("local", "cheap-summary").cost = { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 };
      await f.emit("model_select", { model: f.ctx.model }); await f.waitMaintenance();
    }
    const packed = Array.from({ length: 1000 }, (_, i) => `building artifact ${i}: ${"x".repeat(70)}`).join("\n") + "\nBUILD COMPLETE";
    const { old, active } = await history(f, kind === "packing" ? { oldBody: packed, command: "npm run build" }
      : kind === "two-batches" ? { oldCount: 2 } : {});
    await warmUntilAttempt(f);
    assert.equal(f.calls.length, 0);
    assert.equal(summaries(f).length, 0);
    assertRaw(f, active);
    if (kind === "packing") {
      for (const call of old) assert.equal(await recall(f, call.id), call.result.content[0].text);
    } else assertRaw(f, old);
  });
});

test("group intent storage failure starts no provider work and interrupted groups never publish a partial view", async t => {
  await t.test("intent storage", async t => {
    const f = await groupFixture(t, { mainRates: coldRates, contextTokens: 350000 });
    const { old, active } = await history(f, { prefix: 100000, tail: 166000 });
    const append = f.sm.appendCustomEntry.bind(f.sm);
    let intents = 0;
    t.mock.method(f.sm, "appendCustomEntry", (type, data) => {
      if (type === "context-prune-group-attempt" && ++intents === 1) throw new Error("GROUP_INTENT_FULL");
      return append(type, data);
    });
    await warmUntilAttempt(f, () => intents > 0);
    assert.ok(intents > 0);
    assert.equal(f.calls.length, 0);
    assert.equal(summaries(f).length, 0);
    assertRaw(f, old.concat(active));
    await checkpoint(f);
    assert.equal(f.calls.length, 3, "a local journal failure must not become an upstream outage");
    assert.equal(summaries(f).length, 1);
  });
  await t.test("user cancellation", async t => {
    const f = await groupFixture(t, { defer: true }), { old, active } = await history(f);
    const pending = warmUntilAttempt(f);
    if (!f.calls.length) await once(f.summaryStarted, "request", { signal: AbortSignal.timeout(15000) });
    await f.commands.get("pruner").handler("off", f.ctx);
    await pending;
    assert.equal(f.calls.length, 1);
    assert.equal(summaries(f).length, 0);
    assertRaw(f, old.concat(active));
  });
});

test("in-flight groups stop on source changes, Native pressure and late route changes without partial publication", async t => {
  for (const mutation of ["source", "native", "late-route"]) await t.test(mutation, async t => {
    let f;
    f = await groupFixture(t, { capacity: mutation === "native", reply: n => {
      if (n === 1 && mutation === "source") f.sm.appendMessage({ role: "user", content: "Changed source", timestamp: f.nextTimestamp() });
      if (n === 1 && mutation === "native") f.ctx.getContextUsage = () => ({ tokens: 480000, contextWindow: 500000 });
      return `Independent evidence ${n}.`;
    } });
    const { old, active } = await history(f);
    if (mutation === "late-route") {
      const compare = TokenEstimator.prototype.compare;
      t.mock.method(TokenEstimator.prototype, "compare", async function (before, after, ...args) {
        const counts = await compare.call(this, before, after, ...args);
        if (after.some(message => message.details?.members?.length === 3))
          f.ctx.modelRegistry.find("local", "cheap-summary").baseUrl = "http://changed-during-count.invalid";
        return counts;
      });
    }
    await warmUntilAttempt(f);
    assert.equal(f.calls.length, mutation === "late-route" ? 3 : 1);
    assert.equal(summaries(f).length, 0);
    assertRaw(f, old.concat(active));
  });
});

test("editing or omitting a group restores every source member without paying again", async t => {
  for (const change of ["edited", "omitted"]) await t.test(change, async t => {
    const f = await groupFixture(t), { old, active } = await history(f);
    await warmUntilAttempt(f);
    f.sm.appendContextEdit(summaries(f)[0].id, change === "omitted" ? null : { content: "User-edited evidence" });
    const input = f.sm.buildSessionProjection().messages;
    const visible = (await f.emit("context", { messages: input })).messages;
    for (const call of old.slice(1).concat(active)) assert.deepEqual(visible.find(message => message.toolCallId === call.id), call.result);
    for (const call of old.slice(1)) assert.equal(await recall(f, call.id), call.result.content[0].text);
    assert.equal(f.calls.length, 3);
  });
});

test("group semantic members survive independent and shared chain consumption", async t => {
  const f = await groupFixture(t), { old } = await history(f);
  await warmUntilAttempt(f);
  const text = summaries(f)[0].content;
  assert.ok(text.includes("Independent evidence 1.") && text.includes("Independent evidence 3."));
  const indexer = new ToolCallIndexer(); indexer.reconstructFromSession(f.ctx);
  const raw = f.sm.buildSessionProjection().messages;
  const chains = detectChains(raw).filter(chain => chain.middleToolCallIds.some(id => id === "old-1" || id === "old-2"));
  const shared = await prepareSharedChain(chains, 0, { indexer, blockRefs: new BlockRefIssuer(), messages: raw,
    appendEntry: (type, data) => f.sm.appendCustomEntry(type, data), now: () => Date.now(), diagnostics: { report() {} },
    backfill: { sessionFile: f.sm.getSessionFile() } }, (role, timestamp, messageRole) => {
    const matches = f.sm.getBranch().filter(entry => entry.type === "message" && entry.message.timestamp === timestamp
      && entry.message.role === (messageRole ?? (role === "start" ? "user" : "assistant")));
    return matches.length === 1 ? matches[0].id : undefined;
  }, new Set(), new AbortController().signal);
  assert.equal(shared.members.length, 2);
  const projected = applyChainCompressions(projection(f), chainMembers(shared), entry => entry.rangeSummaryText, false);
  for (let i = 1; i <= 3; i++) assert.ok(JSON.stringify(projected).includes(`Independent evidence ${i}.`));
  await f.commands.get("pruner").handler("compact", f.ctx); await f.waitMaintenance();
  const compacted = projection(f);
  for (let i = 1; i <= 3; i++) assert.ok(JSON.stringify(compacted).includes(`Independent evidence ${i}.`));
  for (const call of old.slice(1)) assert.equal(await recall(f, call.id), call.result.content[0].text);
  f.ctx.sessionManager = SessionManager.open(f.sm.getSessionFile(), f.dir);
  await f.emit("session_start"); await f.waitMaintenance();
  assert.deepEqual(projection(f), compacted);
  assert.equal(f.calls.length, 3);
});

test("Native and OCC retain surviving group ownership after completion, cancellation or failure", async t => {
  for (const occ of [false, true]) for (const outcome of ["completed", "cancelled", "failed"])
    await t.test(`${occ ? "OCC" : "Native"} ${outcome}`, async t => {
      const f = await groupFixture(t, { mode: "tui", capacity: occ }), { old, active } = await history(f);
      await warmUntilAttempt(f);
      assert.equal(summaries(f).length, 1);
      if (occ) {
        const file = join(f.dir, "metis-pi.toml"), config = readFileSync(file, "utf8");
        writeFileSync(file, config.replace("opportunisticCompaction = false", "opportunisticCompaction = true"));
        await f.emit("session_start"); await f.waitMaintenance();
      }
      const before = projection(f), first = f.sm.getBranch().find(entry => entry.type === "message" && entry.message.content === "Old task 2");
      const controller = new AbortController();
      await f.emit("session_before_compact", { signal: controller.signal, reason: "manual", willRetry: false,
        branchEntries: f.sm.getBranch(), preparation: { firstKeptEntryId: first.id, tokensBefore: 403650 } });
      const owner = { sessionId: f.sm.getSessionId(), messages: f.sm.buildSessionProjection().messages, api: f.ctx.model.api, maintenance: true };
      f.events.emit(METIS_EVENTS.condenseProject, owner);
      assert.equal(owner.busy, undefined); assert.deepEqual(owner.messages, before);
      if (outcome === "completed") {
        const id = f.sm.appendCompaction("Earlier group member summarized natively", first.id, 403650);
        await f.emit("session_compact", { compactionEntry: f.sm.getEntry(id), reason: "manual", willRetry: false });
      } else if (outcome === "cancelled") controller.abort();
      else await f.emit("session_compact_failed", { reason: "manual", aborted: false, error: "offline compaction failure" });
      const next = projection(f), surviving = outcome === "completed" ? old.slice(2) : old.slice(1);
      for (const call of surviving) assert.deepEqual(next.find(message => message.toolCallId === call.id),
        before.find(message => message.toolCallId === call.id));
      assertRaw(f, active);
      assert.ok(next.some(message => message.customType === "context-prune-summary"));
      assert.equal(f.calls.length, 3);
    });
});
