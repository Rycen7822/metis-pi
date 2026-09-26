// Diff rules and resource bounds use literal snapshots and independently counted minimal edits.
import test from "node:test";
import assert from "node:assert/strict";
import { computeWriteDiff, buildDiffRows } from "../../src/write-tracker.ts";

test("oversize pre-image cannot fabricate a diff", () => {
  const oversize = computeWriteDiff(
    { existed: true, content: null, binary: false, truncated: true },
    { existed: true, content: "new content\n", binary: false, truncated: false }, "new content\n");
  assert.equal(oversize.kind, "unavailable");
  assert.match(oversize.reason, /too large/);
});

test("diff windows preserve line numbers and separate only distant changes", () => {
  const before = Array.from({ length: 30 }, (_, i) => `old-${i}`);
  const after = [...before];
  after[10] = "changed";
  const built = buildDiffRows(before.join("\n"), after.join("\n"));
  assert.deepEqual([built.added, built.removed], [1, 1]);
  assert.deepEqual(built.rows.map((row) => row.lineNumber), [8, 9, 10, 11, 11, 12, 13, 14]);
  assert.deepEqual(built.rows.filter((row) => row.kind !== "context").map((row) => [row.kind, row.content]),
    [["remove", "old-10"], ["add", "changed"]]);
  assert.equal(built.rows[0].content, "old-7");
  after[24] = "distant";
  const distant = buildDiffRows(before.join("\n"), after.join("\n"));
  assert.deepEqual(distant.rows.map((row) => row.lineNumber ?? row.kind),
    [8, 9, 10, 11, 11, 12, 13, 14, "separator", 22, 23, 24, 25, 25, 26, 27, 28]);
});

test("large rewrites preserve exact rows; an expensive shared-middle trace fails closed", () => {
  const before = Array.from({ length: 4_000 }, (_, i) => `before-${i}`);
  const after = Array.from({ length: 4_000 }, (_, i) => `after-${i}`);
  const built = buildDiffRows(["prefix", ...before, "suffix"].join("\n"), ["prefix", ...after, "suffix"].join("\n"));
  assert.equal(built.added, 4_000);
  assert.equal(built.removed, 4_000);
  assert.deepEqual(built.rows.filter(row => row.kind === "remove").map(row => row.content), before);
  assert.deepEqual(built.rows.filter(row => row.kind === "add").map(row => row.content), after);
  assert.equal(built.rows.at(-1).content, "suffix");
  assert.equal(built.rows.at(-1).lineNumber, 4_002);
  before[2_000] = after[2_000] = "shared middle";
  const oldText = ["prefix", ...before, "suffix"].join("\n");
  const newText = ["prefix", ...after, "suffix"].join("\n");
  const snapshot = (content) => ({ existed: true, content, binary: false, truncated: false });
  const diff = computeWriteDiff(snapshot(oldText), snapshot(newText), newText);
  assert.deepEqual(diff, { kind: "unavailable", added: 0, removed: 0, reason: "diff budget exceeded" });
});

for (const [name, before, after, added, removed] of [
  ["insert into empty", [], ["a", "b"], 2, 0],
  ["delete everything", ["a", "b"], [], 0, 2],
  ["keep identical text", ["a", "b"], ["a", "b"], 0, 0],
  ["remove one repeated line", ["a", "a", "b"], ["a", "b"], 0, 1],
  ["shift alternating repeats", ["a", "b", "a"], ["b", "a", "b"], 1, 1],
  ["reorder repeated runs", ["a", "a", "b", "b", "a"], ["b", "a", "a", "b"], 1, 2],
]) {
  test(`diff trace: ${name} preserves minimal edits and source line numbers`, () => {
    const built = buildDiffRows(before.join("\n"), after.join("\n"));
    assert.deepEqual([built.added, built.removed], [added, removed]);
    for (const row of built.rows) {
      if (row.kind === "remove") assert.equal(row.content, before[row.oldNumber - 1]);
      if (row.kind === "add" || row.kind === "context") assert.equal(row.content, after[row.newNumber - 1]);
    }
  });
}
