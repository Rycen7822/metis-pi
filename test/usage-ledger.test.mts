// usage-ledger.test.mts — session-scope usage ledger: scope math, dedup,
// replacement, rebuild. Spec 11.2.
import test from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, cacheHitRate, sanitizeUsage, toUsageRecord } from "../src/usage-ledger.ts";
import { SUMMARY_CUSTOM_TYPE } from "../src/turn-summary.ts";

const U = (input: number, output: number, cacheRead = 0, cacheWrite = 0, cost?: number) => ({
  input, output, cacheRead, cacheWrite,
  ...(cost === undefined ? {} : { cost: { total: cost } }),
});

test("spec 11.2 math: session Σ and weighted cache rates", () => {
  const ledger = new UsageLedger();
  // r1: input=1000 output=100 cacheRead=9000 cacheWrite=0
  ledger.confirm("test:r1", U(1000, 100, 9000, 0));
  // r2: input=4000 output=200 cacheRead=1000 cacheWrite=0
  ledger.confirm("test:r2", U(4000, 200, 1000, 0));
  const totals = ledger.totals();
  assert.deepEqual(
    { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
    { input: 5000, output: 300, cacheRead: 10000, cacheWrite: 0 },
  );
  // cache(last) = 1000/(4000+1000) = 20%
  assert.equal(Math.round(ledger.cacheRateLast()! * 10) / 10, 20);
  // cache(session) = 10000/15000 = 66.7% (weighted — NOT the 55% average)
  assert.equal(Math.round(cacheHitRate(ledger.totals())! * 10) / 10, 66.7);
  totals.input = -1;
  assert.equal(ledger.totals().input, 5000, "a caller cannot change the cached snapshot");
  ledger.confirm("test:r1", U(2000, 100, 0, 0));
  assert.equal(ledger.totals().input, 6000, "an earlier request can be corrected after totals were read");
  assert.equal(ledger.cacheRateLast(), 20, "correcting an older request does not make it the latest");
});

test("duplicate confirmations and final corrections replace the same request", () => {
  const ledger = new UsageLedger();
  for (const [input, output] of [[800, 50], [800, 50], [1000, 100]] as const) {
    ledger.confirm("p:req-1", U(input, output));
    const totals = ledger.totals();
    assert.equal(totals.input, input);
    assert.equal(totals.output, output);
    assert.equal(ledger.confirmedCount, 1);
  }
});

test("rebuild from session entries dedups against live confirmations", () => {
  const ledger = new UsageLedger();
  ledger.confirm("test-provider:r1", U(1000, 100, 9000, 0));
  ledger.totals();
  const entries = [
    { type: "message", id: "e1", message: { role: "assistant", provider: "test-provider", responseId: "r1", timestamp: 1, usage: U(1000, 100, 9000, 0) } },
    { type: "message", id: "e2", message: { role: "assistant", provider: "test-provider", responseId: "r2", timestamp: 2, usage: U(4000, 200, 1000, 0) } },
  ];
  ledger.rebuild(entries);
  assert.equal(ledger.totals().input, 5000, "live-confirmed r1 not double-counted after rebuild");
  assert.equal(ledger.confirmedCount, 2);
});

test("rebuild: our own summary CustomEntry is excluded; compaction usage counts", () => {
  const ledger = new UsageLedger();
  ledger.rebuild([
    { type: "custom", customType: SUMMARY_CUSTOM_TYPE, id: "c1", usage: U(9999, 9999) },
    { type: "custom", customType: "someone-else:state", id: "c2", usage: U(9999, 9999) },
    { type: "compaction", id: "e9", usage: U(50, 500) },
    { type: "message", id: "e1", message: { role: "assistant", provider: "p", timestamp: 1, usage: U(100, 10) } },
    { type: "message", id: "e2", message: { role: "user", content: [] } }, // user messages: no usage summed
  ]);
  assert.equal(ledger.totals().input, 150);
  assert.equal(ledger.totals().output, 510);
});

test("invalid usage never poisons the ledger (NaN/negative/missing → omitted)", () => {
  assert.equal(toUsageRecord({ input: Number.NaN }), undefined);
  assert.equal(toUsageRecord({ input: -5 }), undefined);
  assert.equal(toUsageRecord({}), undefined);
  assert.deepEqual(sanitizeUsage({ input: NaN, output: 4, cacheRead: -1, cacheWrite: Infinity }), { output: 4 });
  const ledger = new UsageLedger();
  assert.equal(ledger.confirm("k", { input: Number.NaN }), false);
  assert.equal(ledger.confirm("k2", { input: -1 }), false);
  assert.equal(ledger.totals().input, 0);
  assert.equal(ledger.cacheRateLast(), null, "no confirmed requests → unknown, not 0%");
});

test("zero denominator → unknown rate; cacheWrite is not a hit", () => {
  assert.equal(cacheHitRate({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0, costTotal: undefined }), null);
  const ledger = new UsageLedger();
  ledger.confirm("k", U(0, 10, 0, 500));
  // 0/(0+0+500) = 0% — a real value (all misses, some writes), not unknown.
  assert.equal(ledger.cacheRateLast(), 0);
});

test("cost totals accumulate when reported, stay undefined otherwise", () => {
  const ledger = new UsageLedger();
  ledger.confirm("a", U(100, 10, 0, 0, 0.1));
  ledger.confirm("b", U(100, 10, 0, 0, 0.2));
  assert.equal(Math.round(ledger.totals().costTotal! * 100) / 100, 0.3);
  for (const key of ["a", "b"]) ledger.confirm(key, U(100, 10));
  assert.equal(ledger.totals().costTotal, undefined, "correction can remove the last reported cost");
  ledger.reset();
  assert.equal(ledger.totals().input, 0);
  assert.equal(ledger.cacheRateLast(), null);
  assert.equal(ledger.confirmedCount, 0);
});
