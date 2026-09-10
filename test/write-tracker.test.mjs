// Write-tracker tests: honest diffs across all lifecycle and edge cases.
// The tracker must never fabricate a diff — uncertainty is "unavailable".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WriteDiffTracker, snapshotFile, computeWriteDiff, diffLines, resolveWritePath } from "../src/write-tracker.ts";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pcx-write-"));
}

test("new file: Added with +N -0", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "new.ts");
  tracker.trackStart("call-1", "write", { path: target, content: "a\nb\n" }, (p) => p);
  // Simulate the write tool's effect before end fires.
  fs.writeFileSync(target, "a\nb\n");
  const change = tracker.trackEnd("call-1", "write", false);
  assert.equal(change.kind, "add");
  assert.equal(change.added, 2);
  assert.equal(change.removed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("overwrite: Edited with a real diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "over.txt");
  fs.writeFileSync(target, "one\ntwo\nthree\n");
  tracker.trackStart("call-2", "write", { path: target, content: "one\nTWO\nthree\nfour\n" }, (p) => p);
  fs.writeFileSync(target, "one\nTWO\nthree\nfour\n");
  const change = tracker.trackEnd("call-2", "write", false);
  assert.equal(change.kind, "update");
  assert.equal(change.added, 2);
  assert.equal(change.removed, 1);
  assert.match(change.diff, /- 2 two/);
  assert.match(change.diff, /\+ 2 TWO/);
  assert.match(change.diff, /\+ 4 four/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("unchanged content: zero delta, no fabricated diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "same.txt");
  fs.writeFileSync(target, "same\n");
  tracker.trackStart("c", "write", { path: target, content: "same\n" }, (p) => p);
  const change = tracker.trackEnd("c", "write", false);
  assert.equal(change.kind, "update");
  assert.equal(change.added, 0);
  assert.equal(change.removed, 0);
  assert.equal(change.diff, "");
});

test("failed write: unavailable", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "x.txt");
  tracker.trackStart("c", "write", { path: target, content: "x\n" }, (p) => p);
  const change = tracker.trackEnd("c", "write", true);
  assert.equal(change.kind, "unavailable");
  assert.match(change.reason, /failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("binary pre-image: unavailable, never a garbage diff", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "bin.dat");
  fs.writeFileSync(target, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  tracker.trackStart("c", "write", { path: target, content: "text\n" }, (p) => p);
  const change = tracker.trackEnd("c", "write", false);
  assert.equal(change.kind, "unavailable");
  assert.match(change.reason, /binary/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("oversize pre-image: unavailable", () => {
  const snapshot = { existed: true, content: null, binary: false, truncated: true };
  const change = computeWriteDiff(snapshot, "new content\n");
  assert.equal(change.kind, "unavailable");
  assert.match(change.reason, /too large/);
});

test("unreadable pre-image: unavailable", () => {
  const tracker = new WriteDiffTracker();
  tracker.trackStart("c", "write", { path: "/proc/1/mem", content: "x\n" }, (p) => p);
  const change = tracker.trackEnd("c", "write", false);
  assert.equal(change.kind, "unavailable");
});

test("post-write mismatch (file deleted between write and end): unavailable", () => {
  const dir = tmpdir();
  const target = path.join(dir, "gone.txt");
  fs.writeFileSync(target, "old\n");
  const pre = snapshotFile(target);
  fs.rmSync(target);
  // Tracker path: pre captured, then file vanishes before trackEnd reads it.
  const tracker = new WriteDiffTracker();
  tracker.trackStart("c2", "write", { path: target, content: "x\n" }, (p) => p);
  const change2 = tracker.trackEnd("c2", "write", false);
  assert.equal(change2.kind, "unavailable");
  assert.match(change2.reason, /missing|unreadable/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("third-party ownership: non-builtin write tool names are ignored", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const target = path.join(dir, "ext.txt");
  tracker.trackStart("c", "fff-write", { path: target, content: "x\n" }, (p) => p);
  assert.equal(tracker.pendingCount, 0);
  assert.equal(tracker.trackEnd("c", "fff-write", false), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parallel toolCallIds: independent pre-images", () => {
  const tracker = new WriteDiffTracker();
  const dir = tmpdir();
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  fs.writeFileSync(a, "A-old\n");
  fs.writeFileSync(b, "B-old\n");
  tracker.trackStart("p1", "write", { path: a, content: "A-new\n" }, (p) => p);
  tracker.trackStart("p2", "write", { path: b, content: "B-new\n" }, (p) => p);
  assert.equal(tracker.pendingCount, 2);
  fs.writeFileSync(a, "A-new\n");
  fs.writeFileSync(b, "B-new\n");
  const ca = tracker.trackEnd("p1", "write", false);
  const cb = tracker.trackEnd("p2", "write", false);
  assert.equal(ca.added, 1);
  assert.equal(ca.removed, 1);
  assert.match(cb.diff, /\+ 1 B-new/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("diffLines: context window, line numbers, and honest counts", () => {
  const before = Array.from({ length: 30 }, (_, i) => `old-${i}`);
  const after = [...before.slice(0, 10), "changed", ...before.slice(11)];
  const diff = diffLines(before, after);
  assert.match(diff, /- 11 old-10/);
  assert.match(diff, /\+ 11 changed/);
  assert.match(diff, /  8 old-7/); // leading context with correct line numbers
  // 30 lines with a single change: one window, no interior separator.
  assert.doesNotMatch(diff, /     \.\.\./);
});
