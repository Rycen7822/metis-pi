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

