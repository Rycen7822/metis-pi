// host-data.test.mts — the bridge from the REAL Pi context shape to the
// display snapshot. Starts from the real host field names (spec 11.1) and
// asserts boundary validation: nothing invalid crosses as undefined/NaN.
import test from "node:test";
import assert from "node:assert/strict";
import { HostData, toContextUsageSnapshot } from "../../src/host-data.ts";

test("invalid context counters cannot produce a display snapshot", () => {
  assert.equal(toContextUsageSnapshot({ tokens: Number.NaN, contextWindow: 0, percent: 200 }), undefined);
});

test("one bound context retains its receiver across revisions, rebinding, compaction and read failure", () => {
  const data = new HostData();
  let reads = 0;
  let compacted = false;
  let fail = false;
  let leaf = "entry-1";
  let session = "session-1";
  const ctx = {
    model: { id: "test-model", name: "Test Model", provider: "test-provider", contextWindow: 1_000_000 },
    sessionManager: { getLeafId: () => leaf, getSessionId: () => session },
    getContextUsage(this: { model: { contextWindow: number } }) {
      reads += 1;
      if (fail) throw new Error("projection unavailable");
      return { tokens: compacted ? null : reads, contextWindow: this.model.contextWindow, percent: compacted ? null : reads };
    },
  };
  data.bind(ctx);
  assert.equal(data.getModel()?.id, "test-model");
  const first = data.getContextUsage();
  assert.deepEqual(first, { tokens: 1, contextWindow: 1_000_000, percent: 1 }, "host getter retains its receiver");
  for (let frame = 0; frame < 100; frame += 1) assert.equal(data.getContextUsage(), first);
  assert.equal(reads, 1, "animation-only frames do not rebuild the projection");
  data.bump();
  assert.equal(data.getContextUsage()?.tokens, 2, "stream/lifecycle revision invalidates");
  leaf = "entry-2";
  assert.equal(data.getContextUsage()?.tokens, 3, "appends after event dispatch also invalidate");
  session = "session-2";
  assert.equal(data.getContextUsage()?.tokens, 4, "a live session change invalidates");
  ctx.model.contextWindow = 2_000_000;
  assert.equal(data.getContextUsage()?.contextWindow, 2_000_000, "in-place model changes cannot mix windows");
  assert.equal(reads, 5);
  ctx.model = { id: "switched", name: "Switched", provider: "other", contextWindow: 3_000_000 };
  assert.deepEqual(data.getModel(), ctx.model, "replacement models are visible without rebinding");
  assert.deepEqual(data.getContextUsage(), { tokens: 6, contextWindow: 3_000_000, percent: 6 });
  data.bind(undefined);
  assert.equal(data.getModel(), undefined);
  assert.equal(data.getContextUsage(), undefined);
  data.bind(ctx);
  assert.equal(data.getContextUsage()?.tokens, 7, "rebinding never retains the prior snapshot");
  compacted = true;
  data.bump();
  const unknown = data.getContextUsage();
  assert.deepEqual(unknown, { tokens: null, contextWindow: 3_000_000, percent: null });
  assert.equal(data.getContextUsage(), unknown);
  assert.equal(reads, 8, "post-compaction unknown is a valid cached snapshot");
  data.bump();
  fail = true;
  assert.equal(data.getContextUsage(), undefined, "a failure does not return the last good sample");
  fail = false;
  assert.deepEqual(data.getContextUsage(), unknown);
  assert.equal(reads, 10, "transient failures do not poison the cache");
});
