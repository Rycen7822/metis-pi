// turn-summary.test.mts — the persisted interaction summary entry.
import test from "node:test";
import assert from "node:assert/strict";
import { TurnSummary, formatSummaryLine } from "../src/turn-summary.ts";

function harness(persist = true) {
  const appended: Array<{ type: string; data: unknown }> = [];
  const renderers: Array<{ type: string }> = [];
  let wall = 1_700_000_000_000;
  const summary = new TurnSummary({
    appendEntry: (type, data) => appended.push({ type, data }),
    registerEntryRenderer: (type) => renderers.push({ type }),
    persist,
    wall: () => wall,
  });
  return {
    summary,
    appended,
    renderers,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

const SAMPLE = {
  elapsedMs: 65_000,
  thinkingMs: 12_000,
  toolCalls: 4,
  usage: { input: 1500, output: 700, cacheRead: 0, cacheWrite: 0 },
};

test("renderer registered once per session with the namespaced type", () => {
  const h = harness();
  assert.deepEqual(h.renderers.map((r) => r.type), ["pi-codex-appearance:interaction-summary:v1"]);
});

test("agent_settled appends exactly one summary entry (idempotent)", () => {
  const h = harness();
  h.summary.record(SAMPLE, "completed");
  h.summary.record(SAMPLE, "completed"); // duplicate settle in same turn
  assert.equal(h.appended.length, 1);
  const entry = h.appended[0]!;
  assert.equal(entry.type, "pi-codex-appearance:interaction-summary:v1");
  assert.equal(entry.data.schemaVersion, 1);
  assert.equal(entry.data.outcome, "completed");
});

test("completed outcome after 60s shows duration; short ones omit it (Codex reference)", () => {
  assert.equal(
    formatSummaryLine({ elapsedMs: 65_000, thinkingMs: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, "completed"),
    "Worked for 1m 05s",
  );
  assert.equal(
    formatSummaryLine({ elapsedMs: 8_000, thinkingMs: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, "completed"),
    "Worked for 8s",
  );
});

test("interrupted/failed outcomes get explicit labels", () => {
  assert.match(formatSummaryLine({ ...SAMPLE, elapsedMs: 65_000 }, "interrupted"), /Interrupted/);
  assert.match(formatSummaryLine({ ...SAMPLE, elapsedMs: 65_000 }, "failed"), /Failed/);
});

test("persist=false never appends (volatile-only mode)", () => {
  const h = harness(false);
  h.summary.record(SAMPLE, "completed");
  assert.equal(h.appended.length, 0);
});

test("entries carry wall-clock start/end for session-restore rendering", () => {
  const h = harness();
  h.summary.record(SAMPLE, "completed");
  const data = h.appended[0]!.data as Record<string, unknown>;
  assert.equal(typeof data.startedAt, "number");
  assert.equal(typeof data.settledAt, "number");
  assert.equal((data.settledAt as number) - (data.startedAt as number), 65_000);
});
