import test from "node:test";
import assert from "node:assert/strict";
import { UsageLedger, cacheHitRate, sanitizeUsage } from "../../src/appearance/activity/usage-ledger.ts";
import { SUMMARY_CUSTOM_TYPE } from "../../src/appearance/activity/turn-summary.ts";

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
  ledger.confirm("test:r2", U(4000, 200, 1000, 0));
  const totals = ledger.totals();
  assert.deepEqual(
    { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
    { input: 5000, output: 300, cacheRead: 10000, cacheWrite: 0 },
  );
  assert.equal(Math.round(ledger.cacheRateLast()! * 10) / 10, 20);
  // cache(session) = 10000/15000 = 66.7% (weighted — NOT the 55% average)
  assert.equal(Math.round(cacheHitRate(ledger.totals())! * 10) / 10, 66.7);
  totals.input = -1;
  assert.equal(ledger.totals().input, 5000, "a caller cannot change the cached snapshot");
  ledger.confirm("test:r1", U(2000, 100, 0, 0));
  assert.equal(ledger.totals().input, 6000, "an earlier request can be corrected after totals were read");
  assert.equal(ledger.cacheRateLast(), 20, "correcting an older request does not make it the latest");

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

test("conversation totals exclude background warming and remain idempotent after rebuild", () => {
  const ledger = new UsageLedger();
  const assistant = { role: "assistant", provider: "fixture", responseId: "answer", timestamp: 1,
    usage: { ...U(100, 10), cost: { total: 0.20 } } };
  const entries = [
    { type: "message", id: "answer-entry", message: assistant },
    { type: "usage", id: "warm-entry", kind: "cache_warm", provider: "fixture", model: "fixture",
      usage: { ...U(500, 1, 400), cost: { total: 0.05 } } },
  ];
  ledger.rebuild(entries);
  ledger.confirm("fixture:answer", assistant.usage);
  assert.equal(ledger.confirmedCount, 1, "live confirmation and persisted answer share one request key");
  assert.equal(ledger.totals().input, 100);
  assert.equal(ledger.totals().costTotal, 0.20, "the selected conversation scope is not a full provider bill");
  assert.equal(ledger.cacheRateLast(), 0, "background warming does not replace the latest conversation request");
  ledger.rebuild(entries);
  assert.equal(ledger.totals().costTotal, 0.20);
  ledger.rebuild([{ type: "usage", id: "unknown", kind: "unknown", usage: U(10, 1) }]);
  assert.equal(ledger.totals().costTotal, undefined, "absent conversation cost is unknown, not a real zero");
});

test("invalid fields are omitted while valid usage survives", () => {
  assert.deepEqual(sanitizeUsage({ input: NaN, output: 4, cacheRead: -1, cacheWrite: Infinity }), { output: 4 });
});
