import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  RewriteBudget, batchRewriteAdmission, boundedRewritePolicy, protectBatchWorkingSet, protectChainWorkingSet,
  isUsefulWork, summaryRequestCost,
} from "../../src/condense/rewrite-policy.ts";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { detectChains } from "../../src/condense/chain-detector.ts";

const config = { ...DEFAULT_CONFIG.chainCompression, minGainTokens: 1000, minGainFraction: 0.1 };
const model = { id: "test", provider: "local", api: "test", cost: { input: 10, cacheRead: 1 } };
const completion = (timestamp, cached = 320000) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  timestamp, stopReason: "stop", usage: { input: 0, cacheRead: cached, cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: cached / 1_000_000, cacheWrite: 0, total: cached / 1_000_000 } } });
const warm = (budget, current = model, start = 1) => {
  for (let i = 0; i < 3; i++) budget.observe(completion(start + i), current);
};

test("a material rewrite separates the cold receipt from three warm requests and useful growth", () => {
  const budget = new RewriteBudget();
  warm(budget);
  assert.equal(budget.admits(320000, 3000, 8000, config, model, false), false);
  assert.equal(budget.admits(320000, 80000, 235000, config, model, false), true);
  budget.published(320000, 80000, 235000, model);
  budget.observe(completion(4), model, 20000);
  for (const timestamp of [4, 5, 6]) {
    budget.observe(completion(timestamp), model);
    assert.equal(budget.admits(240000, 40000, 200000, config, model, false), false);
  }
  budget.observe(completion(7), model);
  assert.equal(budget.admits(240000, 40000, 200000, config, model, false), true);
});

test("growing 98% forecasts include the cold request, do not cache fresh growth, and require strictly lower total cost", () => {
  const budget = new RewriteBudget();
  warm(budget);
  // Cold: original354000, shortened1000000. Warm requests add2k/4k/6k on BOTH paths:
  // original costs356360/358720/361080; shortened120360/122720/125080. Total saving62000.
  assert.equal(budget.admits(300000, 200000, 0, config, model, false, 61999), true);
  assert.equal(budget.admits(300000, 200000, 0, config, model, false, 62000), false, "equal cost is not cheaper");
  // After70k, fresh2k cannot already be cached: warm costs90000/92000/94000, not a fictional98% hit.
  // Original total486160; shortened total391000, including cold. No extra10% margin is imposed.
  assert.equal(budget.admits(100000, 30000, 65000, config, model, false, 95159), true);
  assert.equal(budget.admits(100000, 30000, 65000, config, model, false, 95160), false);
});

test("cold cost is not repaid twice and actual 98% receipts repay the matching forecast", () => {
  const budget = new RewriteBudget();
  warm(budget);
  assert.equal(budget.admits(300000, 200000, 0, config, model, false), true);
  budget.published(300000, 200000, 0, model);
  budget.observe(completion(4), model, 50000);
  budget.observe({ ...completion(4, 0), usage: { input: 100000, cacheRead: 0, cacheWrite: 0 } }, model);
  for (let i = 1; i <= 3; i++) {
    const input = 100000 + i * 2000;
    budget.observe({ ...completion(4 + i), usage: { input: input * 0.02, cacheRead: input * 0.98, cacheWrite: 0 } }, model);
    assert.equal(budget.admits(100000, 20000, 80000, config, model, false), i === 3);
  }
});

test("opaque requests use their full input and budget a cold rebuild even with an unchanged local prefix", () => {
  const quote = { ...model, cost: { input: 2, cacheRead: 0.1, cacheWrite: 2.5 } }, budget = new RewriteBudget();
  warm(budget, quote);
  const policy = boundedRewritePolicy(config, 24000);
  assert.equal(budget.admits(130000, 20000, 72000, policy, quote, false), true, "visible-only reference");
  assert.equal(budget.admits(130000, 20000, 72000, policy, quote, false, 0,
    { tokens: 190000, opaque: true }), false, "hidden input and cold-cache risk belong to the same forecast");
  assert.equal(budget.admits(130000, 20000, 72000, policy, quote, false, 0,
    { tokens: null, opaque: true }), false, "a checkpoint without post-compaction usage has no complete cost basis");
});

test("remote cache credit follows a matching request and loses the entire affected suffix", () => {
  const quote = { ...model, cost: { input: 2, cacheRead: 0.1, cacheWrite: 2.5 } }, budget = new RewriteBudget();
  const messages = [{ role: "user", timestamp: -1, content: "x".repeat(288000) }, ...history([96000]),
    { role: "user", timestamp: 5, content: "x".repeat(136000) }];
  const before = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const prefix = messages.slice(0, 3).reduce((sum, message) => sum + estimateTokens(message), 0);
  const total = before + 60000, policy = boundedRewritePolicy(config, 24000);
  const context = { tokens: total, opaque: true, cacheKey: "checkpoint-a", messages };
  const admits = (ctx = context) => budget.admits(before, 23000, prefix, policy, quote, false, 0, ctx);
  const payload = { model: quote.id, instructions: "Stable instructions", input: [{ role: "user", content: "Rendered input" }] };
  const request = (timestamp, body = payload) => {
    budget.observeRequest(quote, context.cacheKey, body, messages);
    budget.observe({ ...completion(timestamp), usage: {
      input: total * 0.02, cacheRead: total * 0.98, cacheWrite: 0 } }, quote);
  };
  warm(budget, quote);
  assert.equal(admits(), false, "warm history without an observed request cannot certify the checkpoint cache");
  for (let i = 4; i < 7; i++) request(i);
  assert.equal(admits(), true);
  assert.equal(admits({ ...context, cacheKey: "other-checkpoint" }), false);
  const changed = structuredClone(messages);
  changed[0].content = "y".repeat(changed[0].content.length);
  assert.equal(admits({ ...context, messages: changed }), false);
  request(7, { ...payload, instructions: "Changed instructions" });
  assert.equal(admits(), false, "a changed provider envelope must establish a new reuse window");
  request(8, { ...payload, instructions: "Changed instructions" });
  request(9, { ...payload, instructions: "Changed instructions" });
  assert.equal(admits(), true);
  budget.published(before, 23000, prefix, quote, context);
  budget.observe({ ...completion(10), usage: { input: total - 23000, cacheRead: 0, cacheWrite: 0 } }, quote);
  budget.observe(completion(10), quote, total);
  for (let i = 11; i < 14; i++) request(i);
  assert.equal(admits(), false, "unexpected full-cold usage retains its debt despite a restored high hit rate");
  budget.observeRequest(undefined, undefined, {});
  for (let i = 14; i < 17; i++) request(i);
  assert.equal(admits(), false, "discarding request evidence must preserve unpaid costs");
});

test("both forecast paths apply their own context tier while opaque cold costs remain funded", () => {
  const base = { input: 2, cacheRead: 0.1, cacheWrite: 2.5 }, high = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
  const flat = { ...model, cost: base }, tiered = { ...flat, priceTiers: [{ after: 0, cost: base }, { after: 272000, cost: high }] };
  const policy = boundedRewritePolicy(config, 48000), context = { tokens: 230000, opaque: true };
  const budget = new RewriteBudget();
  warm(budget, flat);
  assert.equal(budget.admits(130000, 30000, 60000, policy, flat, false, 0, context), false);
  warm(budget, tiered, 4);
  assert.equal(budget.admits(130000, 30000, 60000, policy, tiered, false, 0, context), true,
    "only the uncompressed path crosses 272k within the 32-request horizon");
});

test("an unexpectedly cold first receipt adds its actual loss before three warm requests can fund another rewrite", () => {
  const budget = new RewriteBudget();
  warm(budget);
  budget.published(320000, 80000, 235000, model);
  budget.observe({ ...completion(4, 0), usage: { input: 240000, cacheRead: 0, cacheWrite: 0 } }, model);
  budget.observe(completion(4), model, 100000);
  warm(budget, model, 5);
  assert.equal(budget.admits(240000, 80000, 155000, config, model, false), false,
    "restored cache hits do not erase the first request's unpredicted cost");
});

test("a missing first usage retains its cold reserve instead of refunding it from a later warm request", () => {
  for (const stopReason of ["stop", "error"]) {
    const budget = new RewriteBudget();
    warm(budget);
    budget.published(320000, 80000, 235000, model);
    budget.observe({ ...completion(4), usage: undefined, stopReason }, model);
    budget.observe(completion(4), model, 100000);
    for (let timestamp = 5; timestamp <= 8; timestamp++) budget.observe(completion(timestamp, 240000), model);
    assert.equal(budget.waitingForWork(config), true, "missing usage keeps a full cold reserve after cache recovers");
  }
});

test("moving into a quoted tier preserves outstanding cold debt and useful work", () => {
  const base = { input: 2, cacheRead: 0.1, cacheWrite: 2.5 }, high = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
  const tiers = [{ after: 0, cost: base }, { after: 120000, cost: high }];
  const low = { ...model, cost: base, priceTiers: tiers }, next = { ...model, cost: high, priceTiers: tiers, pricing: "pi" };
  const budget = new RewriteBudget(), policy = boundedRewritePolicy(config, 48000);
  warm(budget, low);
  assert.equal(budget.admits(100000, 40000, 0, policy, low, false), true);
  budget.published(100000, 40000, 0, low);
  budget.observe({ ...completion(4, 0), usage: { input: 60000, cacheRead: 0, cacheWrite: 0 } }, low);
  warm(budget, next, 5);
  budget.observe(completion(8), next, 100000);
  assert.equal(budget.waitingForWork(config), true, "a rate selection is not a new provider or an erased ledger");
});

test("past cache spending cannot fund a rewrite that will not repay after cold rebuild and three future requests", () => {
  const budget = new RewriteBudget();
  for (let i = 1; i <= 50; i++) budget.observe(completion(i), model);
  assert.equal(budget.admits(300000, 15000, 13000, { ...config, minimumGain: 0 }, model, false), false);
  assert.equal(budget.admits(329000, 260000, 8000, config, model, false), true,
    "large real savings may repay a cold first request; immediate payback is not required");
  const expensiveWrite = { ...model, cost: { ...model.cost, cacheWrite: 50 } }, writing = new RewriteBudget();
  warm(writing, expensiveWrite);
  assert.equal(budget.admits(100000, 30000, 65000, config, model, false), true);
  assert.equal(writing.admits(100000, 30000, 65000, config, expensiveWrite, false), false,
    "a listed cache-write surcharge is part of rebuilding the old suffix");
});

test("only consecutive matching main requests warm cache; replay, failure, missing usage and route changes do not", () => {
  const budget = new RewriteBudget();
  const admits = current => budget.admits(320000, 80000, 235000, config, current, false);
  budget.observe({ ...completion(1), provider: "other" }, model);
  budget.observe({ ...completion(2), usage: { cacheRead: 320000 } }, model);
  assert.equal(admits(model), false);
  warm(budget, model, 3);
  assert.equal(admits(model), true);
  budget.observe({ ...completion(6), stopReason: "error" }, model);
  budget.observe(completion(7), model);
  budget.observe(completion(7), model);
  budget.observe(completion(8), model);
  assert.equal(admits(model), false, "replayed receipt does not complete a three-request warm interval");
  budget.observe(completion(9), model);
  assert.equal(admits(model), true);
  budget.observe({ ...completion(10), usage: { ...completion(10).usage, input: 100000 } }, model);
  assert.equal(admits(model), false, "a low hit rate restarts consecutive reuse");
  warm(budget, model, 11);
  assert.equal(admits(model), true);
  assert.equal(admits({ ...model, baseUrl: "https://different.invalid" }), false);
  budget.reset();
  assert.equal(admits(model), false);
  assert.equal(budget.admits(320000, 1, 8000, config, model, true), true, "capacity rescue is separate");
});

test("summary fees reserve before work, settle from receipts, and remain charged when attempts produce no receipt", () => {
  const budget = new RewriteBudget();
  warm(budget);
  const admits = fee => budget.admits(100000, 30000, 65000, config, model, false, fee);
  assert.equal(admits(95000), true);
  assert.equal(admits(96000), false);
  const settle = budget.reserveFee(95000);
  assert.equal(admits(0), true);
  settle(100000);
  assert.equal(admits(0), false, "reported cost, not the optimistic reservation, controls publication");
  settle(0);
  assert.equal(admits(0), false, "a repeated receipt cannot refund the same attempt");
  const silent = new RewriteBudget();
  warm(silent);
  const late = silent.reserveFee(100000);
  assert.equal(silent.admits(100000, 30000, 65000, config, model, false), false, "no receipt retains the reservation");
  silent.reset();
  late(0);
  warm(silent);
  assert.equal(silent.admits(100000, 30000, 65000, config, model, false), true, "a late old-route receipt does not affect a new budget");
  const fullPrice = { ...model, cost: { input: 1, cacheRead: 1 } }, cash = new RewriteBudget();
  assert.equal(cash.admits(100000, 30000, 65000, config, fullPrice, false, 1000), true);
  cash.reserveFee(1000);
  cash.published(100000, 30000, 65000, fullPrice);
  cash.observe(completion(1), fullPrice, 10000);
  assert.equal(cash.waitingForWork(config), true, "forecast cold savings cannot refund spent fees before the main receipt");
  cash.observe(completion(1), fullPrice);
  assert.equal(cash.waitingForWork(config), false, "only the real cold receipt settles its forecast savings");
  budget.published(100000, 30000, 13000, model);
  budget.observe(completion(4), model, 100000);
  warm(budget, model, 4);
  assert.equal(admits(0), false, "three warm requests alone do not repay a capacity rescue with large debt");
});

test("bounded candidates use size-specific gain and forecast without redefining semantic text groups", () => {
  assert.equal(boundedRewritePolicy(DEFAULT_CONFIG.chainCompression, 80000), undefined,
    "a large semantic text group stays outside the independent tier");
  const policy = boundedRewritePolicy(DEFAULT_CONFIG.chainCompression, 32008), budget = new RewriteBudget();
  warm(budget);
  assert.equal(budget.admits(1000089, 31917, 896026, DEFAULT_CONFIG.chainCompression, model, false), false);
  assert.ok(policy);
  assert.equal(budget.admits(1000089, 31917, 896026, { ...policy, forecastRequests: 3 }, model, false), false);
  assert.equal(budget.admits(1000089, 31917, 896026, policy, model, false), true);
  const longer = boundedRewritePolicy(DEFAULT_CONFIG.chainCompression, 16000);
  assert.equal(budget.admits(320000, 12000, 256000, { ...longer, forecastRequests: 24 }, model, false), false);
  assert.equal(budget.admits(320000, 12000, 256000, longer, model, false), true, "independent payback retains its 32-request scope");
  const cheap = { ...model, cost: { input: 2, cacheRead: 1 } }, smaller = new RewriteBudget();
  warm(smaller, cheap);
  assert.equal(smaller.admits(1000089, 5917, 922026, DEFAULT_CONFIG.chainCompression, cheap, false), false);
  const small = boundedRewritePolicy(DEFAULT_CONFIG.chainCompression, 6008);
  assert.ok(small);
  assert.equal(smaller.admits(1000089, 5917, 922026, small, cheap, false), true);
});

test("closed request chunks earn local payback without borrowing profit or consuming unread results", () => {
  const quote = { ...model, cost: { input: 2, cacheRead: 0.1, cacheWrite: 2.5 } }, budget = new RewriteBudget();
  warm(budget, quote);
  const raw = history([240000, 256000]);
  const gain = { pi: 58000, proxy: 58000 };
  const frame = batchRewriteAdmission(budget, raw, config, quote);
  assert.equal(frame.accepts(["t0@2"].values(), gain), true, "a profitable closed chunk can use its own 32-request horizon");
  assert.equal(frame.accepts(["t0@2"], gain, 1000000), false, "paid summary fees remain part of the same forecast");
  assert.equal(frame.accepts(["t0@2"], { pi: 1000, proxy: 1000 }), false, "small savings cannot borrow another candidate gain");
  const open = raw.filter(message => message.role !== "user" || message.timestamp === 0)
    .filter(message => !message.content?.some?.(block => block.type === "text" && block.text === "Complete"));
  assert.equal(batchRewriteAdmission(budget, open, config, quote).accepts(["t0@2"], gain), false,
    "a tool-only successor proves consumption, not closure of the text group");
  const unread = [...raw.slice(0, 3), { role: "user", timestamp: 3, content: "pending ".repeat(32000) }];
  assert.equal(batchRewriteAdmission(budget, unread, config, quote).accepts(["t0@2"], gain), false,
    "a new task cannot authorize the previous unread tool output");
});

test("unknown prices use a 1:10 cache/input ratio, while no-discount inputs still honor batch policy", () => {
  for (const cost of [undefined, { input: 0, cacheRead: 0 }]) {
    const unknown = { ...model, cost }, budget = new RewriteBudget();
    warm(budget, unknown);
    assert.equal(budget.admits(100000, 50000, 40000, config, unknown, false), true,
      "unknown quotes use the same cold-plus-three growing forecast in 1:10 relative units");
    assert.equal(budget.admits(300000, 15000, 13000, { ...config, minimumGain: 0 }, unknown, false), false);
  }
  const scheduler = new RewriteBudget();
  assert.equal(scheduler.admits(100000, 20000, 0, config, { ...model, cost: { input: 0, cacheRead: 0 } }, false), false);
  assert.equal(scheduler.admits(100000, 20000, 0, config, { ...model, cost: { input: 1, cacheRead: 1 } }, false), true);
  assert.equal(scheduler.admits(100000, 2000, 0, config, { ...model, cost: { input: 1, cacheRead: 1 } }, false), false);
});

test("unknown prices never turn zero SDK cost into free summaries or mix relative units with dollar receipts", () => {
  const zero = { ...model, cost: { input: 0, output: 0, cacheRead: 0 } };
  const auxiliary = { ...model, cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2 } };
  const receipt = { input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.123 } };
  const known = summaryRequestCost(model, auxiliary, 1000, 100);
  assert.equal(known.cost, 2400);
  assert.equal(known.actual(receipt), 123000, "known currency honors the reported charge");
  const relative = summaryRequestCost(zero, auxiliary, 1000, 100);
  assert.equal(relative.cost, 1200);
  assert.equal(relative.actual(receipt), 220, "unknown main price uses relative input/output units, not dollars");
  const missing = { ...receipt, cost: { total: 0 } };
  assert.equal(summaryRequestCost(model, zero, 1000, 100).actual(missing), 2100);
  assert.equal(summaryRequestCost(zero, zero, 1000, 100).actual(missing), 210);
  const publicFree = summaryRequestCost(model, { ...zero, pricing: "models.dev" }, 1000, 100);
  assert.equal(publicFree.cost, 0, "an explicitly listed free quote differs from an unknown SDK zero");
  assert.equal(publicFree.actual(missing), 0);
  assert.equal(publicFree.actual({ ...receipt, cost: { total: 0.01, totalFromProvider: true } }), 10000);
});

function history(sizes, open = false) {
  const messages = [];
  for (const [i, size] of sizes.entries()) {
    messages.push({ role: "user", timestamp: 4 * i, content: `Task ${i}` },
      { role: "assistant", timestamp: 4 * i + 1, stopReason: "toolUse",
        content: [{ type: "toolCall", id: `t${i}`, name: "read", arguments: {} }] },
      { role: "toolResult", timestamp: 4 * i + 2, toolCallId: `t${i}`, toolName: "read", isError: false,
        content: [{ type: "text", text: "x".repeat(size) }] });
    if (!(open && i === sizes.length - 1)) messages.push({ role: "assistant", timestamp: 4 * i + 3,
      content: [{ type: "text", text: "Complete" }], stopReason: "stop" });
  }
  return messages;
}

test("recent work and token tail are a union; open tasks never authorize arbitrary tool-round cuts", () => {
  const raw = history([1000, 1000, 1000, 1000, 1000], true);
  const chains = detectChains(raw);
  const batches = [{ timestamp: 0, turnIndex: 0, toolCalls: raw.filter(m => m.role === "toolResult").map(m => ({
    toolCallId: m.toolCallId, toolName: m.toolName, args: {}, resultText: m.content[0].text,
    isError: false, resultTimestamp: m.timestamp,
  })) }];
  const work = { ...config, rollingWindow: 0, minWorkTurns: 2, minRecentTokens: 0 };
  assert.deepEqual(protectBatchWorkingSet(batches, raw, raw, work).flatMap(b => b.toolCalls.map(c => c.toolCallId)),
    ["t0", "t1", "t2"], "ordinary batches retain the same recent useful rounds");
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, work).map(c => c.startUserTimestamp), [0, 4, 8]);
  const oneTask = raw.filter(message => message.role !== "user" || message.timestamp === 0);
  assert.deepEqual(protectChainWorkingSet(detectChains(oneTask), oneTask, oneTask, work)
    .map(chain => chain.startUserTimestamp), [0, 3, 7], "an open big task does not pin its closed text groups");
  assert.deepEqual(protectBatchWorkingSet(batches, raw, raw, { ...work, minWorkTurns: 0 })
    .flatMap(batch => batch.toolCalls.map(call => call.toolCallId)), ["t0", "t1", "t2", "t3"], "unread output stays raw even with zero retention");
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...work, minRecentTokens: 100000 }), []);
  const visible = raw.map(message => message.role === "toolResult" ? { ...message, content: [{ type: "text", text: "stub" }] } : message);
  assert.deepEqual(protectChainWorkingSet(chains, raw, visible, { ...work, minRecentTokens: 2000 }), []);
  assert.deepEqual(protectBatchWorkingSet(batches, raw, visible, { ...work, minRecentTokens: 2000 }), [],
    "the recent raw guard is measured on the effective view, including prior stubs");
});

test("one flush groups admitted chunks, then batch and chain share the same refill", () => {
  const budget = new RewriteBudget(), raw = history([10000, 10000]);
  const fullPrice = { ...model, cost: { input: 1, cacheRead: 1 } };
  const frame = batchRewriteAdmission(budget, raw, config, fullPrice);
  const gain = { pi: 1500, proxy: 1500 };
  assert.equal(frame.accepts(["t0@2"], gain), true);
  frame.published(["t0@2"], gain);
  assert.equal(frame.accepts(["t1@6"], gain), true, "a single flush need not refill between chunks");
  frame.published(["t1@6"], gain);
  frame.finish();
  assert.equal(budget.ready(10000, 5000, config, false), false, "another rewrite cannot reuse that growth");
  budget.observe(completion(1), fullPrice, 1000);
  assert.equal(budget.ready(10000, 5000, config, false), true, "no-discount inputs do not acquire a cache-only wait");
});

test("a long open task spends the same reference budget as a closed task without releasing its own evidence", () => {
  const raw = history([40000, 200, 200, 200, 40000], true);
  const chains = detectChains(raw);
  const policy = { ...config, rollingWindow: 3, minWorkTurns: 1, minRecentTokens: 2000 };
  const older = [0, 4, 8, 12];
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, policy).map(c => c.startUserTimestamp), older);
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...policy, rollingWindow: 5 })
    .map(c => c.startUserTimestamp), older, "a larger reference count does not pin old tasks behind the active one");
  const closed = history([40000, 200, 200, 200, 40000]);
  assert.deepEqual(protectChainWorkingSet(detectChains(closed), closed, closed, policy).map(c => c.startUserTimestamp), older);
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...policy, minRecentTokens: 100000 }), [],
    "spending the reference budget never bypasses the effective token tail");
});

test("polling and failures do not age evidence, including incomplete command executions", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "exec_command" }], stopReason: "toolUse" };
  const result = { role: "toolResult", toolCallId: "t", toolName: "exec_command", isError: false, details: { exit_code: 0 } };
  assert.equal(isUsefulWork(message, [result]), true);
  assert.equal(isUsefulWork(message, [{ ...result, details: {} }]), false);
  assert.equal(isUsefulWork(message, [{ ...result, toolName: "write_stdin" }]), false);
  assert.equal(isUsefulWork({ ...message, stopReason: "aborted" }, [result]), false);
  assert.equal(isUsefulWork(message, [{ ...result, isError: true }]), false);
});
