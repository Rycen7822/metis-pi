// usage-ledger.test.mts — session-scope usage ledger: scope math, dedup,
// replacement, rebuild. Spec 11.2.
import test from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, cacheHitRate, toUsageRecord } from "../src/usage-ledger.ts";
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
  assert.equal(Math.round(ledger.cacheRateSession()! * 10) / 10, 66.7);
});

test("duplicate confirmations of the same request never double-count", () => {
  const ledger = new UsageLedger();
  ledger.confirm("p:req-1", U(1000, 100));
  ledger.confirm("p:req-1", U(1000, 100)); // duplicate completion event
  assert.equal(ledger.totals().input, 1000);
  assert.equal(ledger.confirmedCount, 1);
});

test("final usage corrects the confirmed value (replace, not add)", () => {
  const ledger = new UsageLedger();
  ledger.confirm("p:req-1", U(800, 50));
  ledger.confirm("p:req-1", U(1000, 100)); // final correction
  assert.equal(ledger.totals().input, 1000);
  assert.equal(ledger.totals().output, 100);
});

test("rebuild from session entries dedups against live confirmations", () => {
  const ledger = new UsageLedger();
  ledger.confirm("test-provider:r1", U(1000, 100, 9000, 0));
  const entries = [
    { type: "message", id: "e1", message: { role: "assistant", provider: "test-provider", responseId: "r1", timestamp: 1, usage: U(1000, 100, 9000, 0) } },
    { type: "message", id: "e2", message: { role: "assistant", provider: "test-provider", responseId: "r2", timestamp: 2, usage: U(4000, 200, 1000, 0) } },
  ];
  ledger.rebuild(entries, SUMMARY_CUSTOM_TYPE);
  assert.equal(ledger.totals().input, 5000, "live-confirmed r1 not double-counted after rebuild");
  assert.equal(ledger.confirmedCount, 2);
});

test("rebuild: our own summary CustomEntry is excluded; compaction usage counts", () => {
  const ledger = new UsageLedger();
  ledger.rebuild([
    { type: "custom", customType: SUMMARY_CUSTOM_TYPE, id: "c1" },
    { type: "custom", customType: "someone-else:state", id: "c2" },
    { type: "compaction", id: "e9", usage: U(50, 500) },
    { type: "message", id: "e1", message: { role: "assistant", provider: "p", timestamp: 1, usage: U(100, 10) } },
    { type: "message", id: "e2", message: { role: "user", content: [] } }, // user messages: no usage summed
  ], SUMMARY_CUSTOM_TYPE);
  assert.equal(ledger.totals().input, 150);
  assert.equal(ledger.totals().output, 510);
});

test("invalid usage never poisons the ledger (NaN/negative/missing → omitted)", () => {
  assert.equal(toUsageRecord({ input: Number.NaN }), undefined);
  assert.equal(toUsageRecord({ input: -5 }), undefined);
  assert.equal(toUsageRecord({}), undefined);
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

test("preview replaces and clears per attempt", () => {
  const ledger = new UsageLedger();
  ledger.preview(1, U(100, 10));
  ledger.preview(1, U(200, 20));
  assert.deepEqual(ledger.previewRecord(), { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, costTotal: undefined });
  ledger.clearPreview(1);
  assert.equal(ledger.previewRecord(), undefined);
});

test("cost totals accumulate when reported, stay undefined otherwise", () => {
  const ledger = new UsageLedger();
  ledger.confirm("a", U(100, 10, 0, 0, 0.1));
  ledger.confirm("b", U(100, 10, 0, 0, 0.2));
  assert.equal(Math.round(ledger.totals().costTotal! * 100) / 100, 0.3);
  const bare = new UsageLedger();
  bare.confirm("a", U(100, 10));
  assert.equal(bare.totals().costTotal, undefined);
});
