// The tracker must never fabricate a diff — uncertainty is "unavailable".
// New-API contract: trackStart/trackEnd carry the tool's sourceInfo; "write"
// with anything but exact builtin ownership is never tracked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { WriteDiffTracker } from "../../src/write-tracker.ts";
import { resolveNativeMutationPath } from "../../src/native-tool-path.ts";

const BUILTIN = { source: "builtin", path: "builtin:write" };
const FOREIGN = { source: "npm:compatibility-test", path: "/test/custom.ts" };

function fixture(t) {
  const dir = temporaryDirectory(t);
  const tracker = new WriteDiffTracker();
  const file = (name, text) => {
    const target = path.join(dir, name);
    if (text !== undefined) fs.writeFileSync(target, text);
    return target;
  };
  const start = (id, target, content) => tracker.trackStart(id, "write", { path: target, content }, BUILTIN, (p) => p);
  const end = (id, failed = false) => tracker.trackEnd(id, "write", BUILTIN, failed);
  return { tracker, file, start, end };
}

test("interleaved writes retain each pre-image; later calls observe current disk state", (t) => {
  const { file, start, end } = fixture(t);
  const fresh = file("new.txt");
  const existing = file("existing.txt", "old\n");
  start("new", fresh, "a\nb\n");
  start("update", existing, "NEW\n");
  fs.writeFileSync(fresh, "a\nb\n");
  fs.writeFileSync(existing, "NEW\n");
  const updated = end("update");
  const added = end("new");
  assert.deepEqual([updated.kind, updated.added, updated.removed], ["update", 1, 1]);
  assert.deepEqual(updated.rows.map((row) => [row.kind, row.oldNumber ?? row.newNumber, row.content]),
    [["remove", 1, "old"], ["add", 1, "NEW"]]);
  assert.deepEqual([added.kind, added.added, added.removed], ["add", 2, 0]);
  assert.deepEqual(added.rows.map((row) => [row.kind, row.newNumber, row.content]),
    [["add", 1, "a"], ["add", 2, "b"]]);

  start("unchanged", existing, "NEW\n");
  const unchanged = end("unchanged");
  assert.deepEqual([unchanged.kind, unchanged.added, unchanged.removed], ["unchanged", 0, 0]);
  start("raced", existing, "requested\n");
  fs.writeFileSync(existing, "external edit\n");
  const raced = end("raced");
  assert.equal(raced.kind, "unavailable");
  assert.match(raced.reason, /mismatch/, "a later call cannot reuse its predecessor's diff");
  start("failed", fresh, "bad\n");
  const failed = end("failed", true);
  assert.equal(failed.kind, "failed");
  assert.match(failed.reason, /failed/);
});

test("binary pre-images and post-write deletion never produce a garbage diff", (t) => {
  const { file, start, end } = fixture(t);
  start("c", file("bin.dat", Buffer.from([0x00, 0x01, 0x02, 0x03])), "text\n");
  const binChange = end("c");
  assert.equal(binChange.kind, "unavailable");
  assert.match(binChange.reason, /binary/);
  const goneTarget = file("gone.txt", "old\n");
  start("c2", goneTarget, "x\n");
  fs.rmSync(goneTarget);
  const gone = end("c2");
  assert.equal(gone.kind, "unavailable");
  assert.match(gone.reason, /missing|unreadable/);
});

test("writes are only tracked for builtin tools with sourceInfo (adapter installed)", (t) => {
  const { tracker, file } = fixture(t);
  for (const source of [FOREIGN, undefined]) {
    tracker.trackStart("c", "write", { path: file("ext.txt"), content: "x\n" }, source, (p) => p);
    assert.equal(tracker.trackEnd("c", "write", source, false), undefined);
  }
});

test("the native write target and captured pre-image agree across normalized paths", async (t) => {
  const dir = temporaryDirectory(t);
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const cases = [
    ["nested/../relative.txt", path.join(dir, "relative.txt")],
    ["@prefixed.txt", path.join(dir, "prefixed.txt")],
    ["unicode\u00a0space.txt", path.join(dir, "unicode space.txt")],
    [pathToFileURL(path.join(dir, "url.txt")).href, path.join(dir, "url.txt")],
    ["~/home.txt", path.join(dir, "home.txt")],
  ];
  const write = createWriteToolDefinition(dir);
  for (const [input, target] of cases) {
    fs.writeFileSync(target, "before\n");
    const tracker = new WriteDiffTracker();
    tracker.trackStart(input, "write", { path: input, content: "after\n" }, BUILTIN,
      (value) => resolveNativeMutationPath(dir, value));
    await write.execute(input, { path: input, content: "after\n" }, undefined, undefined, { cwd: dir });
    assert.equal(fs.readFileSync(target, "utf8"), "after\n", input);
    const change = tracker.trackEnd(input, "write", BUILTIN, false);
    assert.deepEqual([change?.kind, change?.added, change?.removed], ["update", 1, 1], input);
  }
});
