import assert from "node:assert/strict";
import test from "node:test";
import { ChainScheduler, protectChainWorkingSet, isChainWork } from "../../src/condense/chain-scheduler.ts";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { detectChains } from "../../src/condense/chain-detector.ts";

const config = { ...DEFAULT_CONFIG.chainCompression, minGainTokens: 1000, minGainFraction: 0.1 };
const model = { id: "test", provider: "local", api: "test", cost: { input: 10, cacheRead: 1 } };
const completion = (timestamp, cached = 320000) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  timestamp, stopReason: "stop", usage: { cacheRead: cached, cost: { cacheRead: cached / 1_000_000 } } });

test("a batch must be material and refill after publication rather than follow the same high water level", () => {
  const scheduler = new ChainScheduler();
  assert.equal(scheduler.admits(320000, 3000, 8000, config, model, false), false);
  assert.equal(scheduler.admits(320000, 80000, 235000, config, model, false), true);
  scheduler.published(80000);
  assert.equal(scheduler.admits(240000, 40000, 200000, config, model, false), false);
  scheduler.observe(completion(1), model, 20000);
  assert.equal(scheduler.admits(240000, 40000, 200000, config, model, false), true);
});

test("old history may use bounded observed spending, but the same receipt or allowance cannot be reused", () => {
  const scheduler = new ChainScheduler();
  for (let i = 1; i <= 9; i++) scheduler.observe(completion(i), model);
  const affordable = () => scheduler.admits(329000, 260000, 8000, config, model, false);
  assert.equal(affordable(), false);
  for (let i = 1; i <= 9; i++) scheduler.observe(completion(i), model);
  assert.equal(affordable(), false, "replayed receipts cannot close the shortfall");
  scheduler.observe(completion(10), model);
  assert.equal(affordable(), true);
  scheduler.published(260000);
  scheduler.observe(completion(10), model);
  scheduler.observe(completion(11), model, 100000);
  assert.equal(affordable(), false, "publication consumes the allowance but not receipt identity");
});

test("unknown, failed and mismatched usage cannot earn budget; model/lifecycle changes revoke old allowance", () => {
  const scheduler = new ChainScheduler();
  const admits = current => scheduler.admits(320000, 260000, 8000, config, current, false);
  scheduler.observe({ ...completion(1, 10000000), stopReason: "aborted" }, model);
  scheduler.observe({ ...completion(2, 10000000), model: "other" }, model);
  scheduler.observe({ ...completion(3), usage: { cacheRead: 10000000 } }, model);
  assert.equal(admits(model), false);
  scheduler.observe(completion(4, 10000000), model);
  assert.equal(admits(model), true);
  assert.equal(admits({ ...model, baseUrl: "https://different.invalid" }), false);
  scheduler.observe(completion(5, 10000000), model);
  scheduler.reset();
  assert.equal(admits(model), false);
  assert.equal(scheduler.admits(320000, 1, 8000, config, model, true), true, "safe capacity relief is separate");
});

test("zero/unknown prices stay conservative while no-discount inputs still honor batch policy", () => {
  const scheduler = new ChainScheduler();
  assert.equal(scheduler.admits(100000, 20000, 0, config, { ...model, cost: { input: 0, cacheRead: 0 } }, false), false);
  assert.equal(scheduler.admits(100000, 20000, 0, config, { ...model, cost: { input: 1, cacheRead: 1 } }, false), true);
  assert.equal(scheduler.admits(100000, 2000, 0, config, { ...model, cost: { input: 1, cacheRead: 1 } }, false), false);
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
  const work = { ...config, rollingWindow: 0, minWorkTurns: 2, minRecentTokens: 0 };
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, work).map(c => c.startUserTimestamp), [0, 4, 8]);
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...work, minRecentTokens: 100000 }), []);
  const visible = raw.map(message => message.role === "toolResult" ? { ...message, content: [{ type: "text", text: "stub" }] } : message);
  assert.deepEqual(protectChainWorkingSet(chains, raw, visible, { ...work, minRecentTokens: 2000 }), []);
});

test("recent small closed tasks fit the reference budget without pinning a large old task", () => {
  const raw = history([40000, 200, 200, 200, 40000], true);
  const chains = detectChains(raw);
  const policy = { ...config, rollingWindow: 3, minWorkTurns: 1, minRecentTokens: 2000 };
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, policy).map(c => c.startUserTimestamp), [0]);
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...policy, rollingWindow: 5 })
    .map(c => c.startUserTimestamp), [0], "increasing the reference count still cannot pin the oversized old task");
  assert.deepEqual(protectChainWorkingSet(chains, raw, raw, { ...policy, rollingWindow: 0 })
    .map(c => c.startUserTimestamp), [0, 4, 8, 12]);
});

test("polling and failures do not age evidence, including incomplete command executions", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", id: "t", name: "exec_command" }], stopReason: "toolUse" };
  const result = { role: "toolResult", toolCallId: "t", toolName: "exec_command", isError: false, details: { exit_code: 0 } };
  assert.equal(isChainWork(message, [result]), true);
  assert.equal(isChainWork(message, [{ ...result, details: {} }]), false);
  assert.equal(isChainWork(message, [{ ...result, toolName: "write_stdin" }]), false);
  assert.equal(isChainWork({ ...message, stopReason: "aborted" }, [result]), false);
  assert.equal(isChainWork(message, [{ ...result, isError: true }]), false);
});
