// Write-tracker tests: honest diffs across all lifecycle and edge cases.
// The tracker must never fabricate a diff — uncertainty is "unavailable".
// New-API contract: trackStart/trackEnd carry the tool's sourceInfo; "write"
// with anything but exact builtin ownership is never tracked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WriteDiffTracker, computeWriteDiff, buildDiffRows } from "../../src/write-tracker.ts";

const BUILTIN = { source: "builtin", path: "<builtin:write>" };
const FOREIGN = { source: "npm:compatibility-test", path: "/test/custom.ts" };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pcx-write-"));
}

test("new file: Added with +N -0 and all-insert rows", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "new.ts");
  tracker.trackStart("call-1", "write", { path: target, content: "a\nb\n" }, BUILTIN, (p) => p);
  // Simulate the write tool's effect before end fires.
  fs.writeFileSync(target, "a\nb\n");
  const change = tracker.trackEnd("call-1", "write", BUILTIN, false);
  assert.equal(change.kind, "add");
  assert.equal(change.added, 2);
  assert.equal(change.removed, 0);
  assert.equal(change.rows.length, 2);
  assert.equal(change.rows[0].kind, "add");
  assert.equal(change.rows[0].newNumber, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overwrite: Edited with a real structured diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "over.txt");
  fs.writeFileSync(target, "one\ntwo\nthree\n");
  tracker.trackStart("call-2", "write", { path: target, content: "one\nTWO\nthree\nfour\n" }, BUILTIN, (p) => p);
  fs.writeFileSync(target, "one\nTWO\nthree\nfour\n");
  const change = tracker.trackEnd("call-2", "write", BUILTIN, false);
  assert.equal(change.kind, "update");
  assert.equal(change.added, 2);
  assert.equal(change.removed, 1);
  const removed = change.rows.find((row) => row.kind === "remove");
  const adds = change.rows.filter((row) => row.kind === "add");
  assert.deepEqual([removed.oldNumber, removed.content], [2, "two"]);
  assert.deepEqual(adds.map((row) => [row.newNumber, row.content]), [[2, "TWO"], [4, "four"]]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unchanged content: unchanged kind, no fabricated diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "same.txt");
  fs.writeFileSync(target, "same\n");
  tracker.trackStart("c", "write", { path: target, content: "same\n" }, BUILTIN, (p) => p);
  const change = tracker.trackEnd("c", "write", BUILTIN, false);
  assert.equal(change.kind, "unchanged");
  assert.equal(change.added, 0);
  assert.equal(change.removed, 0);
});

test("failed write: failed kind (never presented as success)", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "x.txt");
  tracker.trackStart("c", "write", { path: target, content: "x\n" }, BUILTIN, (p) => p);
  const change = tracker.trackEnd("c", "write", BUILTIN, true);
  assert.equal(change.kind, "failed");
  assert.match(change.reason, /failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unavailable pre-images: binary, oversize, unreadable and post-write-deleted never produce a garbage diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  // binary pre-image
  const binTarget = path.join(dir, "bin.dat");
  fs.writeFileSync(binTarget, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  tracker.trackStart("c", "write", { path: binTarget, content: "text\n" }, BUILTIN, (p) => p);
  const binChange = tracker.trackEnd("c", "write", BUILTIN, false);
  assert.equal(binChange.kind, "unavailable");
  assert.match(binChange.reason, /binary/);
  // oversize pre-image
  const oversize = computeWriteDiff(
    { existed: true, content: null, binary: false, truncated: true },
    { existed: true, content: "new content\n", binary: false, truncated: false }, "new content\n");
  assert.equal(oversize.kind, "unavailable");
  assert.match(oversize.reason, /too large/);
  // unreadable pre-image
  tracker.trackStart("u", "write", { path: "/proc/1/mem", content: "x\n" }, BUILTIN, (p) => p);
  assert.equal(tracker.trackEnd("u", "write", BUILTIN, false).kind, "unavailable");
  // file deleted between write and end
  const goneTarget = path.join(dir, "gone.txt");
  fs.writeFileSync(goneTarget, "old\n");
  tracker.trackStart("c2", "write", { path: goneTarget, content: "x\n" }, BUILTIN, (p) => p);
  fs.rmSync(goneTarget);
  const gone = tracker.trackEnd("c2", "write", BUILTIN, false);
  assert.equal(gone.kind, "unavailable");
  assert.match(gone.reason, /missing|unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writes are only tracked for builtin tools with sourceInfo (adapter installed)", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "ext.txt");
  // same-named tool from an extension: sourceInfo not builtin → never tracked
  tracker.trackStart("c", "write", { path: target, content: "x\n" }, FOREIGN, (p) => p);
  assert.equal(tracker.pendingCount, 0);
  assert.equal(tracker.trackEnd("c", "write", FOREIGN, false), undefined);
  // builtin write without sourceInfo (adapter not installed): never tracked
  tracker.trackStart("n", "write", { path: target, content: "x\n" }, undefined, (p) => p);
  assert.equal(tracker.pendingCount, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parallel toolCallIds: independent pre-images", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, "A-old\n");
  fs.writeFileSync(b, "B-old\n");
  tracker.trackStart("p1", "write", { path: a, content: "A-new\n" }, BUILTIN, (p) => p);
  tracker.trackStart("p2", "write", { path: b, content: "B-new\n" }, BUILTIN, (p) => p);
  assert.equal(tracker.pendingCount, 2);
  fs.writeFileSync(a, "A-new\n");
  fs.writeFileSync(b, "B-new\n");
  const ca = tracker.trackEnd("p1", "write", BUILTIN, false);
  const cb = tracker.trackEnd("p2", "write", BUILTIN, false);
  assert.equal(ca.kind, "update");
  assert.equal(ca.added, 1);
  assert.equal(ca.removed, 1);
  assert.equal(cb.kind, "update"); // b.txt existed (B-old) — an overwrite, not an add
  fs.rmSync(dir, { recursive: true, force: true });
});

test("same path, two sequential writes: second call must not present the first call's diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "seq.txt");
  fs.writeFileSync(target, "v1\n");
  tracker.trackStart("s1", "write", { path: target, content: "v2\n" }, BUILTIN, (p) => p);
  fs.writeFileSync(target, "v2\n");
  const first = tracker.trackEnd("s1", "write", BUILTIN, false);
  assert.equal(first.kind, "update");
  // A second overlapping write on the same path while our snapshot is stale.
  tracker.trackStart("s2", "write", { path: target, content: "DIFFERENT\n" }, BUILTIN, (p) => p);
  fs.writeFileSync(target, "v3\n");
  const second = tracker.trackEnd("s2", "write", BUILTIN, false);
  assert.equal(second.kind, "unavailable");
  assert.match(second.reason, /mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diffRows: context windows, line numbers, honest counts, separators", () => {
  const before = Array.from({ length: 30 }, (_, i) => `old-${i}`);
  const after = [...before.slice(0, 10), "changed", ...before.slice(11)];
  const built = buildDiffRows(before.join("\n"), after.join("\n"));
  assert.equal(built.added, 1);
  assert.equal(built.removed, 1);
  const kinds = built.rows.map((row) => row.kind);
  assert.ok(kinds.includes("remove"));
  assert.ok(kinds.includes("add"));
  const removed = built.rows.find((row) => row.kind === "remove");
  const added = built.rows.find((row) => row.kind === "add");
  assert.deepEqual([removed.oldNumber, removed.content], [11, "old-10"]);
  assert.deepEqual([added.newNumber, added.content], [11, "changed"]);
  // Leading context keeps old numbering (11-3 = 8).
  const context = built.rows.filter((row) => row.kind === "context");
  assert.ok(context.some((row) => row.lineNumber === 8 && row.content === "old-7"));
  // 30 lines with a single change: one window, no interior separator.
  assert.ok(!built.rows.some((row) => row.kind === "separator"));
});

test("diffRows: two distant changes produce a separator between windows", () => {
  const before = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const after = [...before.slice(0, 3), "A", ...before.slice(4, 30), "B", ...before.slice(31)];
  const built = buildDiffRows(before.join("\n"), after.join("\n"));
  const separators = built.rows.filter((row) => row.kind === "separator");
  assert.equal(separators.length, 1);
});

test("diffRows: complete large rewrites keep exact rows without a quadratic trace", () => {
  const before = Array.from({ length: 4_000 }, (_, i) => `before-${i}`);
  const after = Array.from({ length: 4_000 }, (_, i) => `after-${i}`);
  const built = buildDiffRows(["prefix", ...before, "suffix"].join("\n"), ["prefix", ...after, "suffix"].join("\n"));
  assert.equal(built.added, 4_000);
  assert.equal(built.removed, 4_000);
  assert.deepEqual(built.rows.filter(row => row.kind === "remove").map(row => row.content), before);
  assert.deepEqual(built.rows.filter(row => row.kind === "add").map(row => row.content), after);
  assert.equal(built.rows.at(-1).content, "suffix");
  assert.equal(built.rows.at(-1).lineNumber, 4_002);
});

test("diffRows: excessive edit distance fails closed rather than returning a partial diff", () => {
  const before = Array.from({ length: 2_000 }, (_, i) => `before-${i}`);
  const after = Array.from({ length: 2_000 }, (_, i) => `after-${i}`);
  before[1_000] = after[1_000] = "shared middle";
  const oldText = ["prefix", ...before, "suffix"].join("\n");
  const newText = ["prefix", ...after, "suffix"].join("\n");
  assert.equal(buildDiffRows(oldText, newText), undefined);
  const snapshot = (content) => ({ existed: true, content, binary: false, truncated: false });
  const diff = computeWriteDiff(snapshot(oldText), snapshot(newText), newText);
  assert.deepEqual(diff, { kind: "unavailable", added: 0, removed: 0, reason: "diff budget exceeded" });
});

test("diffRows: compact traces retain minimal edits and line numbering across repeated lines", () => {
  // Deterministic small inputs compared with an independent LCS oracle.
  const variants = [[], ["a"], ["b", "a"], ["a", "b", "a"], ["b", "a", "b", "a"], ["a", "a", "b", "b", "a"]];
  for (const before of variants) for (const after of variants) {
    const lcs = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
    for (let i = 1; i <= before.length; i++) for (let j = 1; j <= after.length; j++) {
      lcs[i][j] = before[i - 1] === after[j - 1]
        ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
    const built = buildDiffRows(before.join("\n"), after.join("\n"));
    const common = lcs[before.length][after.length];
    assert.equal(built.added, after.length - common);
    assert.equal(built.removed, before.length - common);
    for (const row of built.rows) {
      if (row.kind === "remove") assert.equal(row.content, before[row.oldNumber - 1]);
      if (row.kind === "add" || row.kind === "context") assert.equal(row.content, after[row.newNumber - 1]);
    }
  }
});

