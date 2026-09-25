// turn-summary.test.mts — the persisted interaction summary entry (v2 schema
// with runtime verdict; v1 legacy entries stay readable, never rewritten).
import test from "node:test";
import assert from "node:assert/strict";
import { TurnSummary, formatSummaryLine, SUMMARY_CUSTOM_TYPE, makeEntryRenderer } from "../../src/turn-summary.ts";

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

test("agent_settled appends exactly one v2 summary entry (idempotent), renderer registered once", () => {
  const appended: Array<{ type: string; data: unknown }> = [];
  const renderers: string[] = [];
  const summary = new TurnSummary({
    appendEntry: (type, data) => appended.push({ type, data }),
    registerEntryRenderer: (type) => renderers.push(type),
    persist: true,
    wall: () => 1_700_000_000_000,
  });
  assert.deepEqual(renderers, [SUMMARY_CUSTOM_TYPE], "renderer registered once with the namespaced type");
  summary.record(SAMPLE, { ...COMPLETED_VERDICT, toolErrorsObserved: 2 });
  summary.record(SAMPLE, { ...COMPLETED_VERDICT, toolErrorsObserved: 2 }); // duplicate settle in same turn
  assert.equal(appended.length, 1);
  const entry = appended[0]!;
  assert.equal(entry.type, SUMMARY_CUSTOM_TYPE);
  const data = entry.data as Record<string, unknown>;
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.outcome, "completed", "tool errors are diagnostic counts, never the verdict");
  assert.equal(data.evidence, "assistant-stop");
  assert.equal(data.toolErrorsObserved, 2);
  // Wall-clock start/end ride along for session-restore rendering.
  assert.equal(typeof data.startedAt, "number");
  assert.equal(typeof data.settledAt, "number");
  assert.equal((data.settledAt as number) - (data.startedAt as number), 65_000);
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
    { elapsedMs: 939_000, thinkingMs: 100_000, usage: { input: 205_000, output: 19_200 } },
    "completed",
  );
  assert.equal(line, "Worked for 15m 39s · thought for 1m 40s · ↓19.2k · ↑205k");
});

for (const [schemaVersion, outcome, matches, absent] of [
  [1, "failed", [/Ended after 5s/, /legacy status unverified/], undefined],
  [1, "completed", [/Worked for 5s/], /legacy/],
  [2, "failed", [/Failed after 5s/], undefined],
  [2, "unknown", [/Ended after 5s/], /Worked|Failed/],
] as const) {
  test(`v${schemaVersion} ${outcome}: legacy status stays unverified; v2 uses terminal evidence`, () => {
    const renderer = makeEntryRenderer() as (entry: unknown) => { render(w: number): string[] } | undefined;
    const entry = renderer({
      customType: SUMMARY_CUSTOM_TYPE,
      data: {
        schemaVersion, outcome, interactionId: "entry", startedAt: 1, settledAt: 2, elapsedMs: 5000,
        ...(schemaVersion === 2 ? { evidence: outcome === "failed" ? "assistant-error" : "settled-only",
          reason: "r", attempt: outcome === "failed" ? 1 : 0, toolErrorsObserved: 0 } : {}),
      },
    });
    const text = entry!.render(120).join("\n");
    for (const expected of matches) assert.match(text, expected);
    if (absent) assert.doesNotMatch(text, absent);
  });
}
