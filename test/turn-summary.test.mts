// turn-summary.test.mts — the persisted interaction summary entry (v2 schema
// with runtime verdict; v1 legacy entries stay readable, never rewritten).
import test from "node:test";
import assert from "node:assert/strict";
import { TurnSummary, formatSummaryLine, SUMMARY_CUSTOM_TYPE, makeEntryRenderer } from "../src/turn-summary.ts";

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

const COMPLETED_VERDICT = {
  outcome: "completed" as const,
  evidence: "assistant-stop" as const,
  reason: "final assistant attempt 1 stopReason=stop",
  attempt: 1,
  toolErrorsObserved: 0,
};

const SAMPLE = {
  active: false,
  phase: "idle" as const,
  startedAt: undefined, // host wall anchor absent → derived from wall - elapsed
  elapsedMs: 65_000,
  thinkingMs: 12_000,
  thinkingOpen: false,
  usage: { input: 1500, output: 700, cacheRead: 0, cacheWrite: 0 },
  tools: undefined,
};

test("renderer registered once per session with the namespaced type", () => {
  const h = harness();
  assert.deepEqual(h.renderers.map((r) => r.type), [SUMMARY_CUSTOM_TYPE]);
});

test("agent_settled appends exactly one v2 summary entry (idempotent)", () => {
  const h = harness();
  h.summary.record(SAMPLE, COMPLETED_VERDICT);
  h.summary.record(SAMPLE, COMPLETED_VERDICT); // duplicate settle in same turn
  assert.equal(h.appended.length, 1);
  const entry = h.appended[0]!;
  assert.equal(entry.type, SUMMARY_CUSTOM_TYPE);
  const data = entry.data as Record<string, unknown>;
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.outcome, "completed");
  assert.equal(data.evidence, "assistant-stop");
  assert.equal(data.toolErrorsObserved, 0);
});

test("tool errors are diagnostic counts in the entry, not the verdict", () => {
  const h = harness();
  h.summary.record(SAMPLE, { ...COMPLETED_VERDICT, toolErrorsObserved: 2 });
  const data = h.appended[0]!.data as Record<string, unknown>;
  assert.equal(data.outcome, "completed");
  assert.equal(data.toolErrorsObserved, 2);
});

test("completed/interrupted/failed/incomplete/unknown label grammar", () => {
  const base = { elapsedMs: 65_000, thinkingMs: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(formatSummaryLine(base, "completed"), "Worked for 1m 05s");
  assert.equal(formatSummaryLine(base, "interrupted"), "Interrupted after 1m 05s");
  assert.equal(formatSummaryLine(base, "failed"), "Failed after 1m 05s");
  assert.equal(formatSummaryLine(base, "incomplete"), "Ended after 1m 05s · output limit");
  assert.equal(formatSummaryLine(base, "unknown"), "Ended after 1m 05s");
});

test("thought + tokens follow the duration in the Codex order", () => {
  const line = formatSummaryLine(
    { elapsedMs: 939_000, thinkingMs: 100_000, usage: { input: 205_000, output: 19_200, cacheRead: 0, cacheWrite: 0 } },
    "completed",
  );
  assert.equal(line, "Worked for 15m 39s · thought for 1m 40s · ↓19.2k · ↑205k");
});

test("persist=false never appends (volatile-only mode)", () => {
  const h = harness(false);
  h.summary.record(SAMPLE, COMPLETED_VERDICT);
  assert.equal(h.appended.length, 0);
});

test("entries carry wall-clock start/end for session-restore rendering", () => {
  const h = harness();
  h.summary.record(SAMPLE, COMPLETED_VERDICT);
  const data = h.appended[0]!.data as Record<string, unknown>;
  assert.equal(typeof data.startedAt, "number");
  assert.equal(typeof data.settledAt, "number");
  assert.equal((data.settledAt as number) - (data.startedAt as number), 65_000);
});

test("v1 legacy entries: failed renders unverified, completed stays worked", () => {
  const renderer = makeEntryRenderer() as (entry: unknown) => { render(w: number): string[] } | undefined;
  const v1Failed = renderer({
    customType: SUMMARY_CUSTOM_TYPE,
    data: { schemaVersion: 1, interactionId: "i1", startedAt: 1, settledAt: 2, elapsedMs: 5000, outcome: "failed" },
  });
  assert.match(v1Failed!.render(120).join("\n"), /Ended after 5s/);
  assert.match(v1Failed!.render(120).join("\n"), /legacy status unverified/);
  const v1Worked = renderer({
    customType: SUMMARY_CUSTOM_TYPE,
    data: { schemaVersion: 1, interactionId: "i2", startedAt: 1, settledAt: 2, elapsedMs: 5000, outcome: "completed" },
  });
  assert.match(v1Worked!.render(120).join("\n"), /Worked for 5s/);
  assert.doesNotMatch(v1Worked!.render(120).join("\n"), /legacy/);
});

test("v2 failed renders Failed (real terminal evidence); unknown renders Ended", () => {
  const renderer = makeEntryRenderer() as (entry: unknown) => { render(w: number): string[] } | undefined;
  const v2Failed = renderer({
    customType: SUMMARY_CUSTOM_TYPE,
    data: {
      schemaVersion: 2, interactionId: "i3", startedAt: 1, settledAt: 2, elapsedMs: 5000,
      outcome: "failed", evidence: "assistant-error", reason: "r", attempt: 1, toolErrorsObserved: 0,
    },
  });
  assert.match(v2Failed!.render(120).join("\n"), /Failed after 5s/);
  const v2Unknown = renderer({
    customType: SUMMARY_CUSTOM_TYPE,
    data: {
      schemaVersion: 2, interactionId: "i4", startedAt: 1, settledAt: 2, elapsedMs: 5000,
      outcome: "unknown", evidence: "settled-only", reason: "r", attempt: 0, toolErrorsObserved: 0,
    },
  });
  assert.match(v2Unknown!.render(120).join("\n"), /Ended after 5s/);
  assert.doesNotMatch(v2Unknown!.render(120).join("\n"), /Worked|Failed/);
});
