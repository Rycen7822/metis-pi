// usage-ledger.test.mts — session-scope usage ledger: scope math, dedup,
// replacement, rebuild. Spec 11.2.
import test from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, cacheHitRate, sanitizeUsage } from "../../src/usage-ledger.ts";
import { SUMMARY_CUSTOM_TYPE } from "../../src/turn-summary.ts";

const U = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input, output, cacheRead, cacheWrite,
});

test("one ledger owns confirmations, corrections, weighted totals and session reconstruction", () => {
  const ledger = new UsageLedger();
  assert.equal(ledger.cacheRateLast(), null, "unconfirmed usage remains unknown");
  for (const input of [Number.NaN, -1]) assert.equal(ledger.confirm("invalid", { input }), false);
  assert.equal(ledger.totals().input, 0);
  for (const [input, output, cacheRead] of [[800, 50, 0], [800, 50, 0], [1000, 100, 9000]] as const) {
    ledger.confirm("test:r1", U(input, output, cacheRead));
    const totals = ledger.totals();
    assert.equal(totals.input, input);
    assert.equal(totals.output, output);
    assert.equal(totals.cacheRead, cacheRead);
    assert.equal(ledger.confirmedCount, 1, "replays and final corrections replace one request");
  }
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

  // Rebuild replaces a live ledger, excludes custom entries and includes compaction usage.
  ledger.rebuild([
    { type: "custom", customType: SUMMARY_CUSTOM_TYPE, id: "c1", usage: U(9999, 9999) },
    { type: "custom", customType: "someone-else:state", id: "c2", usage: U(9999, 9999) },
    { type: "compaction", id: "e9", usage: U(50, 500) },
    { type: "message", id: "e1", message: { role: "assistant", provider: "p", timestamp: 1, usage: U(100, 10) } },
    { type: "message", id: "e2", message: { role: "user", content: [] } }, // user messages: no usage summed
  ]);
  assert.equal(ledger.totals().input, 150);
  assert.equal(ledger.totals().output, 510);
  assert.equal(ledger.confirmedCount, 2, "reconstruction must discard the previous live request keys");
  ledger.rebuild([]);
  assert.equal(ledger.confirmedCount, 0, "a new empty session discards all previous usage");
  assert.equal(cacheHitRate(ledger.totals()), null, "zero denominator is unknown");
  assert.equal(ledger.cacheRateLast(), null, "session reset also forgets the latest request");
  ledger.confirm("cache-write", U(0, 10, 0, 500));
  assert.equal(ledger.cacheRateLast(), 0, "cache writes count as misses, not unknown usage");
});

test("invalid fields are omitted while valid usage survives", () => {
  assert.deepEqual(sanitizeUsage({ input: NaN, output: 4, cacheRead: -1, cacheWrite: Infinity }), { output: 4 });
});
