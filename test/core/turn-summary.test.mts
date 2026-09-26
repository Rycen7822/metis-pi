// Summary text rules and legacy entry rendering; persistence is owned by contract/appearance.
import test from "node:test";
import assert from "node:assert/strict";
import { formatSummaryLine, SUMMARY_CUSTOM_TYPE, makeEntryRenderer } from "../../src/turn-summary.ts";

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
