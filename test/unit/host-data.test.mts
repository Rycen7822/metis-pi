// host-data.test.mts — the bridge from the REAL Pi context shape to the
// display snapshot. Starts from the real host field names (spec 11.1) and
// asserts boundary validation: nothing invalid crosses as undefined/NaN.
import test from "node:test";
import assert from "node:assert/strict";
import { HostData, toModelSnapshot, toContextUsageSnapshot } from "../../src/host-data.ts";

/** Real Pi 0.85.1 context shape (spec 11.1). */
function realCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    hasUI: true,
    model: { id: "test-model", name: "Test Model", provider: "test-provider", contextWindow: 1_000_000 },
    thinkingLevel: "high",
    cwd: "/tmp/workspace",
    getContextUsage() {
      return { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 };
    },
    ui: {},
    ...overrides,
  };
}

test("toModelSnapshot: real shape → id/name/provider/window", () => {
  assert.deepEqual(toModelSnapshot({ id: "m", name: "N", provider: "p", contextWindow: 100 }), {
    id: "m", name: "N", provider: "p", contextWindow: 100,
  });
  assert.equal(toModelSnapshot({ label: "old-wrong-field" }), undefined, "no id → not displayable");
  assert.equal(toModelSnapshot(null), undefined);
  assert.equal(toModelSnapshot("model"), undefined);
});

test("toContextUsageSnapshot: validates every field", () => {
  assert.deepEqual(
    toContextUsageSnapshot({ tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 }),
    { tokens: 172_000, contextWindow: 1_000_000, percent: 17.2 },
  );
  // null tokens (post-compaction) stays null, percent null too
  assert.deepEqual(
    toContextUsageSnapshot({ tokens: null, contextWindow: 1_000_000, percent: null }),
    { tokens: null, contextWindow: 1_000_000, percent: null },
  );
  assert.equal(toContextUsageSnapshot({ tokens: Number.NaN, contextWindow: 0, percent: 200 }), undefined);
  assert.equal(toContextUsageSnapshot(undefined), undefined);
  assert.equal(toContextUsageSnapshot("usage"), undefined);
});

test("live reads: model switch visible WITHOUT re-bind (no frozen copies)", () => {
  const data = new HostData();
  const ctx = realCtx();
  data.bind(ctx);
  assert.equal(data.getModel()?.id, "test-model");
  // The host swaps the model object on ctx — a session_start copy would miss it.
  ctx.model = { id: "switched", provider: "other", contextWindow: 2_000_000 };
  assert.equal(data.getModel()?.id, "switched");
  assert.equal(data.getContextUsage()?.tokens, 172_000);
});

test("getContextUsage tolerates a throwing host getter", () => {
  const data = new HostData();
  data.bind(realCtx({ getContextUsage() { throw new Error("not ready"); } }));
  assert.equal(data.getContextUsage(), undefined);
});

test("getters need this: host context methods called with correct receiver", () => {
  const data = new HostData();
  const ctx = realCtx({
    _usage: { tokens: 5, contextWindow: 10, percent: 50 },
    getContextUsage() { return (this as Record<string, unknown>)._usage; },
  });
  data.bind(ctx);
  assert.equal(data.getContextUsage()?.tokens, 5, "receiver preserved");
});

test("context usage reuses one projection until an event, live branch or model changes", () => {
  const data = new HostData();
  let reads = 0;
  let leaf = "entry-1";
  let session = "session-1";
  const ctx = realCtx({
    sessionManager: { getLeafId: () => leaf, getSessionId: () => session },
    getContextUsage() {
      reads += 1;
      return { tokens: reads, contextWindow: this.model.contextWindow, percent: reads };
    },
  });
  data.bind(ctx);
  const first = data.getContextUsage();
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
  data.bind(undefined);
  assert.equal(data.getContextUsage(), undefined);
  data.bind(ctx);
  assert.equal(data.getContextUsage()?.tokens, 6, "rebinding never retains the prior snapshot");
});

test("unknown context usage is cached, but failed reads are retried rather than cached as empty", () => {
  const data = new HostData();
  let reads = 0;
  let fail = false;
  data.bind(realCtx({
    getContextUsage() {
      reads += 1;
      if (fail) throw new Error("projection unavailable");
      return { tokens: null, contextWindow: 100, percent: null };
    },
  }));
  assert.deepEqual(data.getContextUsage(), { tokens: null, contextWindow: 100, percent: null });
  data.getContextUsage();
  assert.equal(reads, 1, "post-compaction unknown is a valid snapshot");
  data.bump();
  fail = true;
  assert.equal(data.getContextUsage(), undefined, "a failure does not return the last good sample");
  fail = false;
  assert.equal(data.getContextUsage()?.tokens, null);
  assert.equal(reads, 3, "transient failures do not poison the cache");
});

