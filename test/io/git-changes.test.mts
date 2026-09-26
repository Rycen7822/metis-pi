// Real Git worktree/HEAD behavior and filesystem line-count/cache contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory as tempDir } from "../helpers/temp-dir.mjs";
import { git, committedRepository, trackedRepo, refreshAndExpectSample } from "../helpers/git.mts";
import { createLineCountCache, MAX_UNTRACKED_BYTES, readLineCount, resolveHead } from "../../src/git-changes.ts";

test("readLineCount streams: text, no trailing newline, binary, oversized, missing", async (t) => {
  const dir = tempDir(t, "metis-pi-lines-");
  for (const [name, text, lines] of [
    ["text", "a\nb\n", 2], ["unterminated", "a\nb", 2], ["empty", "", 0],
    ["multiple chunks", `${"x".repeat(99)}\n`.repeat(2_000), 2_000],
    ["binary", Buffer.from([0x50, 0x00, 0x51]), undefined],
    ["oversized", "x".repeat(MAX_UNTRACKED_BYTES + 1), undefined],
  ] as const) {
    const file = join(dir, name);
    writeFileSync(file, text);
    assert.deepEqual(await readLineCount(file), lines === undefined ? undefined
      : { lines, size: Buffer.byteLength(text), mtimeMs: statSync(file).mtimeMs }, name);
  }
  assert.equal(await readLineCount(join(dir, "missing.txt")), undefined);
  assert.equal(await readLineCount(dir), undefined, "a directory is not a file");
});

test("one real repository tracks WIP, partial commits, renames and a damaged HEAD", async (t) => {
  const keepText = "line\n".repeat(999) + "extra\n";
  const dir = committedRepository(t, { "a.txt": "one\ntwo\nthree\n", "keep.txt": keepText });
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\nthree\nfour\n");
  writeFileSync(join(dir, "notes.md"), "alpha\nbeta\ngamma\n");
  const tracker = trackedRepo(t, dir);
  await refreshAndExpectSample(tracker, 4, 0, 2); // existing tracked +1 and untracked +3
  await refreshAndExpectSample(tracker, 4, 0, 2); // unchanged reads do not accumulate

  git(dir, "add", "a.txt");
  appendFileSync(file, "five\n");
  await refreshAndExpectSample(tracker, 5, 0, 2); // staged +1 and unstaged +1 count once against HEAD
  git(dir, "add", "notes.md");
  await refreshAndExpectSample(tracker, 5, 0, 2); // a staged new file is no longer also untracked

  writeFileSync(file, `${"x".repeat(50)}\n`.repeat(1_000));
  await refreshAndExpectSample(tracker, 1_003, 3, 2);
  writeFileSync(file, "one\ntwo\nthree\nfour\nfive\n");
  await refreshAndExpectSample(tracker, 5, 0, 2); // returning to the WIP content erases rewrite history

  appendFileSync(join(dir, "keep.txt"), "preexisting\n");
  await refreshAndExpectSample(tracker, 6, 0, 3);
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "partial", "--", "a.txt");
  await refreshAndExpectSample(tracker, 4, 0, 2); // committed +2 disappears; dirty keep and staged notes remain
  renameSync(join(dir, "keep.txt"), join(dir, "renamed.txt"));
  git(dir, "add", "-A");
  await refreshAndExpectSample(tracker, 4, 0, 2); // rename preserves 1000 unchanged lines, without a phantom deletion

  renameSync(join(dir, "renamed.txt"), join(dir, "keep.txt"));
  writeFileSync(join(dir, "keep.txt"), keepText);
  git(dir, "reset", "-q", "HEAD", "--", ".");
  rmSync(join(dir, "notes.md"));
  await refreshAndExpectSample(tracker, 0, 0, 0); // reverting all remaining WIP clears the segment

  appendFileSync(file, "last change\n");
  await refreshAndExpectSample(tracker, 1, 0, 1);
  const branch = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, ".git", branch), "not-a-sha\n");
  await refreshAndExpectSample(tracker, 1, 0, 1); // damaged HEAD retains the last good sample
});

test("real git: untracked text counts; ignored, binary and oversized do not", async (t) => {
  const dir = committedRepository(t, {
    "a.txt": "one\ntwo\nthree\n", ".gitignore": "ignored.txt\n", "b.bin": Buffer.from([0, 1, 2]),
  });
  writeFileSync(join(dir, "ignored.txt"), "x\ny\nz\n");
  writeFileSync(join(dir, "text.md"), "a\nb\nc\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0x50, 0x00, 0x51, 0x0a]));
  writeFileSync(join(dir, "huge.txt"), "x".repeat(MAX_UNTRACKED_BYTES + 1));
  const tracker = trackedRepo(t, dir);
  await refreshAndExpectSample(tracker, 3, 0, 1);

  // A tracked deletion counts its lines; a tracked binary change counts as a
  // file with no line counts — exactly what git reports.
  rmSync(join(dir, "a.txt"));
  writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 3]));
  await refreshAndExpectSample(tracker, 3, 3, 3); // −3 a.txt, 0/0 b.bin, +3 text.md
});

test("real git: an unborn HEAD counts staged new files and their unstaged edits", async (t) => {
  const dir = tempDir(t, "metis-pi-unborn-");
  git(dir, "init", "-q");
  assert.deepEqual(await resolveHead(dir), { kind: "unborn" }, "a live branch with no commits");
  writeFileSync(join(dir, "staged.txt"), "a\nb\nc\n");
  git(dir, "add", "staged.txt");                     // staged new file
  appendFileSync(join(dir, "staged.txt"), "d\ne\n"); // unstaged edits on top
  writeFileSync(join(dir, "untracked.txt"), "x\ny\n");
  const tracker = trackedRepo(t, dir);
  await refreshAndExpectSample(tracker, 7, 0, 2);
  assert.equal(tracker.session().rev, undefined, "no HEAD yet");

  // Staging the rest does not change the work-tree sample.
  git(dir, "add", "staged.txt");
  await refreshAndExpectSample(tracker, 7, 0, 2);

  // The first commit turns the empty-tree baseline into a real HEAD.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  await refreshAndExpectSample(tracker, 0, 0, 0);
  const head = await resolveHead(dir);
  assert.equal(head.kind, "head");
  assert.match(head.kind === "head" ? head.rev : "", /^[0-9a-f]{40}$/);
});

test("createLineCountCache re-reads only when size or mtime moved", async (t) => {
  const dir = tempDir(t, "metis-pi-cache-");
  const file = join(dir, "f.txt");
  writeFileSync(file, "a\nb\n");
  let reads = 0;
  const cache = createLineCountCache({
    read: async (path) => {
      reads += 1;
      return await readLineCount(path);
    },
  });
  assert.equal((await cache.count(file))?.lines, 2);
  assert.equal((await cache.count(file))?.lines, 2);
  assert.equal(reads, 1, "unchanged size+mtime is served from the cache");
  writeFileSync(file, "a\nb\nc\n");
  assert.equal((await cache.count(file))?.lines, 3);
  assert.equal(reads, 2);
  cache.clear();
  assert.equal((await cache.count(file))?.lines, 3);
  assert.equal(reads, 3, "clear() drops the entry");
});
