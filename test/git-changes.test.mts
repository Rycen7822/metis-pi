// git-changes.test.mts — the footer's session change counts (+A −D).
// Three layers: the pure parsers/stat math, the reader (pinned git contract),
// and the tracker. Since 0.19.3 the counts are the session's observed CHURN:
// every read diffs each changed path's content against the content the session
// last saw, and adds the difference — so an edit that adds 14 lines and a later
// edit that removes them count +14 AND −14. The session's first read is the
// content reference (work that predates the session never counts), a commit
// folds the committed delta out, a clean work tree resets the totals. The last
// cases run real git in a temp repo, including mid-session commits.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countsGrowth,
  createGitChangesTracker,
  createLineCountCache,
  findGitDir,
  foldCommitted,
  GIT_CHANGES_DEBOUNCE_MS,
  MAX_UNTRACKED_BYTES,
  parseNumstatZ,
  parseUntracked,
  readChangeSample,
  readLineCount,
  resolveSessionRev,
  samePathState,
  type ChangeSample,
  type GitExec,
  type PathSnapshot,
} from "../src/git-changes.ts";

function tempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal repo marker so findGitDir() accepts the directory. */
function fakeRepo(t: TestContext): string {
  const dir = tempDir(t, "pi-codexy-git-");
  mkdirSync(join(dir, ".git"));
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A real repo with one commit and a clean tree. */
function realRepo(t: TestContext): string {
  const dir = tempDir(t, "pi-codexy-real-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const sample = (tracked: [string, number, number][], untracked: [string, number][] = []): ChangeSample => ({
  tracked: new Map(tracked.map(([path, additions, deletions]) => [path, { additions, deletions }])),
  untracked: new Map(untracked),
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Line-count cache stub: fake repos have no files to stat. */
const fakeCounts = (lines: Record<string, number>) => ({
  count: async (path: string) => {
    const value = lines[path.split("/").pop()!];
    return value === undefined ? undefined : { lines: value, size: value, mtimeMs: 1 };
  },
  clear: () => { /* stub */ },
});

test("numstat -z rows: binary counts as a file, renames key on the new path", () => {
  assert.equal(parseNumstatZ("").size, 0);
  assert.deepEqual([...parseNumstatZ("3\t1\tsrc/a.ts\0")], [["src/a.ts", { additions: 3, deletions: 1 }]]);
  // Binary rows carry "-": the file counts, the line counts do not.
  assert.deepEqual([...parseNumstatZ("-\t-\tassets/logo.png\0")], [["assets/logo.png", { additions: 0, deletions: 0 }]]);
  // Rename: counts, an empty field, then old and new path (keyed by the new one).
  assert.deepEqual([...parseNumstatZ("1\t2\t\0old.ts\0new.ts\0")], [["new.ts", { additions: 1, deletions: 2 }]]);
  // A path may contain a tab or a newline: only NUL splits fields.
  assert.deepEqual([...parseNumstatZ("4\t0\tdir/we\tird.txt\0")], [["dir/we\tird.txt", { additions: 4, deletions: 0 }]]);
  assert.deepEqual(
    [...parseNumstatZ("5\t5\tb.ts\0-\t-\tbin.dat\0")].map(([path]) => path),
    ["b.ts", "bin.dat"],
  );
  assert.equal(parseNumstatZ("bogus\0").size, 0, "short rows are ignored");
});

test("untracked paths split on NUL, ignoring the trailing empty entry", () => {
  assert.deepEqual(parseUntracked(""), []);
  assert.deepEqual(parseUntracked("a.txt\0"), ["a.txt"]);
  assert.deepEqual(parseUntracked("a.txt\0dir with space/b.txt\0"), ["a.txt", "dir with space/b.txt"]);
});

test("readLineCount streams: text, no trailing newline, binary, oversized, missing", async (t) => {
  const dir = tempDir(t, "pi-codexy-lines-");
  const text = join(dir, "text.txt");
  writeFileSync(text, "a\nb\n");
  assert.deepEqual(await readLineCount(text), { lines: 2, size: 4, mtimeMs: statSync(text).mtimeMs });
  const unterminated = join(dir, "unterminated.txt");
  writeFileSync(unterminated, "a\nb");
  assert.equal((await readLineCount(unterminated))?.lines, 2);
  const empty = join(dir, "empty.txt");
  writeFileSync(empty, "");
  assert.equal((await readLineCount(empty))?.lines, 0);
  // 2000 lines of 100 chars: several read chunks, still under the byte cap.
  const long = join(dir, "long.txt");
  writeFileSync(long, `${"x".repeat(99)}\n`.repeat(2_000));
  assert.equal((await readLineCount(long))?.lines, 2_000);
  const binary = join(dir, "binary.bin");
  writeFileSync(binary, Buffer.from([0x50, 0x00, 0x51]));
  assert.equal(await readLineCount(binary), undefined);
  const huge = join(dir, "huge.txt");
  writeFileSync(huge, "x".repeat(MAX_UNTRACKED_BYTES + 1));
  assert.equal(await readLineCount(huge), undefined, "over the byte cap");
  assert.equal(await readLineCount(join(dir, "missing.txt")), undefined);
  assert.equal(await readLineCount(dir), undefined, "a directory is not a file");
});

test("line-count cache re-reads only when size or mtime moved", async (t) => {
  const dir = tempDir(t, "pi-codexy-cache-");
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
  assert.equal(reads, 1, "unchanged file is served from the cache");
  appendFileSync(file, "c\n");
  assert.equal((await cache.count(file))?.lines, 3);
  assert.equal(reads, 2, "a grown file is re-read");
  // Same size, different mtime (an in-place rewrite) must also invalidate.
  writeFileSync(file, "x\ny\n");
  const past = new Date(Date.now() + 5_000);
  utimesSync(file, past, past);
  assert.equal((await cache.count(file))?.lines, 2);
  assert.equal(reads, 3, "a rewritten file is re-read");
  cache.clear();
  assert.equal((await cache.count(file))?.lines, 2);
  assert.equal(reads, 4, "clear() drops the cache");
});

test("churn math: a commit folds out, an unreadable path grows, a stat decides", () => {
  // A commit takes its committed delta out of the session totals (clamped).
  assert.deepEqual(foldCommitted({ additions: 17, deletions: 14 }, { additions: 6, deletions: 5 }), { additions: 11, deletions: 9 });
  assert.deepEqual(foldCommitted({ additions: 2, deletions: 1 }, { additions: 9, deletions: 9 }), { additions: 0, deletions: 0 }, "never negative");
  // The fallback for paths whose content cannot be referenced: growth only.
  assert.deepEqual(countsGrowth({ additions: 11, deletions: 9 }, { additions: 22, deletions: 18 }), { additions: 11, deletions: 9 });
  assert.deepEqual(countsGrowth({ additions: 22, deletions: 18 }, { additions: 11, deletions: 9 }), { additions: 0, deletions: 0 }, "a revert is not negative churn");
  // A snapshot describes one work-tree state, missing paths included.
  const seen: PathSnapshot = { blob: "b", missing: false, size: 3, mtimeMs: 7, counts: { additions: 1, deletions: 0 } };
  assert.equal(samePathState(seen, { size: 3, mtimeMs: 7 }), true);
  assert.equal(samePathState(seen, { size: 4, mtimeMs: 7 }), false, "size moved");
  assert.equal(samePathState(seen, { size: 3, mtimeMs: 8 }), false, "mtime moved");
  assert.equal(samePathState(seen, undefined), false, "the file is gone");
  const gone: PathSnapshot = { ...seen, missing: true, size: 0, mtimeMs: 0 };
  assert.equal(samePathState(gone, undefined), true);
  assert.equal(samePathState(gone, { size: 1, mtimeMs: 1 }), false, "recreated");
});

test("readChangeSample pins the git contract and counts untracked lines", async (t) => {
  const dir = fakeRepo(t);
  const seen: string[] = [];
  const exec: GitExec = async (args) => {
    seen.push(args.join(" "));
    const key = args.join(" ");
    if (key.startsWith("diff --numstat -z")) return { ok: true, stdout: "3\t1\tsrc/a.ts\0-\t-\tassets/logo.png\0" };
    if (key === "ls-files --others --exclude-standard -z") return { ok: true, stdout: "notes.md\0binary.bin\0" };
    return { ok: false, stdout: "" };
  };
  const readSample = await readChangeSample(dir, { exec, rev: "abc123", lineCounts: fakeCounts({ "notes.md": 2 }) });
  assert.equal(readSample.kind, "sample");
  const got = readSample.kind === "sample" ? readSample.sample : undefined;
  assert.deepEqual([...got!.tracked], [
    ["src/a.ts", { additions: 3, deletions: 1 }],
    ["assets/logo.png", { additions: 0, deletions: 0 }],
  ]);
  // The uncountable untracked blob is skipped rather than counted as zero.
  assert.deepEqual([...got!.untracked], [["notes.md", 2]]);
  assert.deepEqual(seen, [
    "diff --numstat -z --no-ext-diff --no-textconv abc123",
    "ls-files --others --exclude-standard -z",
  ]);
});

test("readChangeSample reports no-repo and error distinctly, and rev resolution degrades", async (t) => {
  const dir = fakeRepo(t);
  // Unborn HEAD → no rev, and the read then compares index ↔ work tree.
  const noRev = await resolveSessionRev(dir, { exec: async () => ({ ok: false, stdout: "" }) });
  assert.equal(noRev, undefined);
  assert.equal(await resolveSessionRev(dir, { exec: async () => ({ ok: true, stdout: "deadbeef\n" }) }), "deadbeef");

  const seen: string[] = [];
  const index = await readChangeSample(dir, {
    exec: async (args) => { seen.push(args.join(" ")); return { ok: true, stdout: "" }; },
    lineCounts: fakeCounts({}),
  });
  assert.equal(index.kind, "sample", "no rev → index vs work tree");
  assert.equal(seen[0], "diff --numstat -z --no-ext-diff --no-textconv");

  assert.equal((await readChangeSample(dir, { exec: async () => ({ ok: false, stdout: "" }) })).kind, "error");
  assert.equal((await readChangeSample(tempDir(t, "pi-codexy-nogit-"))).kind, "no-repo");
  assert.equal(findGitDir(""), undefined);
});

test("tracker: the first read is the baseline, later reads are session deltas", async (t) => {
  const dir = fakeRepo(t);
  let rev = "rev1\n";
  let tracked = "11\t9\ta.ts\0";       // work in progress when the session starts
  let untracked = "notes.md\0";
  // What a commit swept past the baseline (oldRev → newRev), keyed by request.
  let committed = "22\t18\ta.ts\0" + "6\t5\tb.ts\0" + "5\t0\tnotes.md\0";
  let updates = 0;
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return { ok: true, stdout: rev };
    // The two-revision form only comes from the commit fold.
    if (key === "diff --numstat -z --no-ext-diff --no-textconv rev1 rev2") return { ok: true, stdout: committed };
    if (key.startsWith("diff --numstat -z")) return { ok: true, stdout: tracked };
    if (key === "ls-files --others --exclude-standard -z") return { ok: true, stdout: untracked };
    return { ok: false, stdout: "" };
  };
  const lineCounts = fakeCounts({ "notes.md": 5, "fresh.md": 5 });
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts, onUpdate: () => { updates += 1; } });
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "pre-existing work is the baseline");
  // The state is the work tree vs HEAD right now: a.ts (+11 −9) and the five
  // untracked lines of notes.md.
  assert.deepEqual(tracker.session(), { rev: "rev1", tracking: true, observations: 1, state: { additions: 16, deletions: 9 } });
  assert.equal(updates, 1, "the baseline publishes once (0/0 hides the segment)");

  tracked = ["22\t18\ta.ts", "6\t5\tb.ts"].join("\0") + "\0";   // +11 −9 in A, +6 −5 in B
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 17, deletions: 14, files: 2 });
  assert.equal(updates, 2);

  // A commit lands: HEAD moves, the work tree is clean against the new rev,
  // and the committed delta folds out of the baseline — the footer CLEARS.
  rev = "rev2\n";
  tracked = "";
  untracked = "";
  await tracker.refresh();
  assert.equal(tracker.session().rev, "rev2", "the session rev follows HEAD");
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "a commit clears the stat");
  assert.equal(updates, 3);

  // Work made AFTER the commit counts fresh against the new revision; a file
  // the session creates counts its whole content.
  tracked = "3\t0\ta.ts\0";
  untracked = "fresh.md\0";
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 8, deletions: 0, files: 2 }, "+3 committed-after, +5 for the new file");
  assert.equal(updates, 4);

  // Undoing everything returns the tree to its reference state, which resets the
  // totals (0.15.4): a clean work tree shows nothing.
  tracked = "";
  untracked = "";
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 });

  tracker.dispose();
  assert.equal(tracker.running, false);
  assert.equal(tracker.snapshot(), undefined);
});

test("tracker: a failed read keeps the last good numbers", async (t) => {
  const dir = fakeRepo(t);
  let fail = false;
  const exec: GitExec = async (args) => {
    if (args.join(" ").startsWith("rev-parse")) return { ok: true, stdout: "r\n" };
    if (fail) return { ok: false, stdout: "" };
    return { ok: true, stdout: args.join(" ").startsWith("diff") ? "4\t0\ta.ts\n" : "" };
  };
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts: fakeCounts({}) });
  await tracker.refresh();                            // baseline
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "baseline is clean");
  // git starts failing mid-session (locked repo, timeout, no metadata)
  fail = true;
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "a failed read keeps the last good numbers");
  tracker.dispose();
  fail = false;

  let stdout = "4\t0\ta.ts\n";
  const tracker2 = createGitChangesTracker({
    getCwd: () => dir,
    lineCounts: createLineCountCache({ read: async () => undefined }),
    exec: async (args) => {
      if (args.join(" ").startsWith("rev-parse")) return { ok: true, stdout: "r\n" };
      if (args.join(" ").startsWith("diff")) return { ok: true, stdout };
      return { ok: true, stdout: "" };
    },
  });
  await tracker2.refresh();
  stdout = "9\t0\ta.ts\n";
  await tracker2.refresh();
  assert.deepEqual(tracker2.snapshot(), { additions: 5, deletions: 0, files: 1 });
  tracker2.dispose();
});

test("tracker: interval, activity refresh and dispose", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const dir = fakeRepo(t);
  let additions = 2;
  let reads = 0;
  let updates = 0;
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return { ok: true, stdout: "r\n" };
    if (key.startsWith("diff")) {
      reads += 1;
      return { ok: true, stdout: `${additions}\t0\ta.ts\n` };
    }
    return { ok: true, stdout: "" };
  };
  const tracker = createGitChangesTracker({
    getCwd: () => dir,
    exec,
    lineCounts: fakeCounts({}),
    onUpdate: () => { updates += 1; },
    intervalMs: 1000,
  });
  assert.equal(tracker.running, false);
  tracker.touch();
  assert.equal(reads, 0, "touch before start is a no-op");
  tracker.start();
  assert.equal(tracker.running, true);
  await tracker.refresh();
  assert.equal(reads, 1, "start reads once for the baseline");

  // Activity-driven refresh: debounced, then a real read.
  additions = 5;
  tracker.touch();
  tracker.touch();
  t.mock.timers.tick(GIT_CHANGES_DEBOUNCE_MS - 10);
  await flush();
  assert.equal(reads, 1, "still inside the debounce window");
  t.mock.timers.tick(20);
  await tracker.refresh();
  assert.equal(reads, 2, "activity triggers a read");
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 0, files: 1 });
  assert.equal(updates, 2);

  // The interval keeps polling independently of activity.
  additions = 9;
  t.mock.timers.tick(1000);
  await tracker.refresh();
  assert.equal(reads, 3);
  assert.deepEqual(tracker.snapshot(), { additions: 7, deletions: 0, files: 1 });

  tracker.dispose();
  assert.equal(tracker.running, false);
  assert.equal(tracker.snapshot(), undefined);
  assert.deepEqual(tracker.session(), { rev: undefined, tracking: false, observations: 0, state: { additions: 0, deletions: 0 } });
  tracker.touch();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, 3, "disposed tracker stops polling");
});

test("tracker coalesces concurrent refreshes and drops a read that lands after dispose", async (t) => {
  const dir = fakeRepo(t);
  let release: ((value: { ok: boolean; stdout: string }) => void) | undefined;
  let reads = 0;
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return { ok: true, stdout: "r\n" };
    if (!key.startsWith("diff")) return { ok: true, stdout: "" };
    reads += 1;
    return await new Promise((resolve) => { release = resolve; });
  };
  let updates = 0;
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts: fakeCounts({}), onUpdate: () => { updates += 1; } });
  const first = tracker.refresh();
  const second = tracker.refresh();
  assert.equal(first, second, "in-flight read is reused (same promise)");
  await flush();
  assert.equal(reads, 1);
  tracker.dispose();
  release?.({ ok: true, stdout: "9\t9\ta.ts\n" });
  await Promise.all([first, second]);
  assert.deepEqual(tracker.snapshot(), undefined, "late read must not resurrect the stat");
  assert.equal(updates, 0);
});

test("real git: a commit clears the stat and later edits count against the new HEAD", async (t) => {
  const dir = realRepo(t);
  // Work in progress when the session starts: NOT the session's work.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  const rev = await resolveSessionRev(dir);
  assert.ok(rev, "HEAD resolves");
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec: undefined, intervalMs: 60_000 });
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "pre-existing edit is baselined");

  // The session edits like an agent tool would: rewrite one file (+2 −1)…
  writeFileSync(join(dir, "a.txt"), "one\nthree\nfour\nfive\nsix\nseven\n");
  // …and let a SCRIPT create and edit another file (no tool ledger involved).
  execFileSync("sh", ["-c", `printf 'x\\ny\\n' > ${join(dir, "scripted.txt")} && printf 'p\\nq\\nr\\n' >> ${join(dir, "scripted.txt")}`]);
  await tracker.refresh();
  // a.txt: baseline had +2 −0 vs HEAD, now +4 −1 → the session added 2, removed 1.
  // scripted.txt: created by the script, untracked, 5 lines → +5.
  assert.deepEqual(tracker.snapshot(), { additions: 7, deletions: 1, files: 2 });

  // Committing that work moves HEAD: the tree is clean again, so the footer
  // clears — and the session revision follows the new HEAD.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "mid-session");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "a commit clears the stat");
  assert.notEqual(tracker.session().rev, rev, "the session rev follows HEAD");

  // …and work made after the commit counts fresh, from the new HEAD.
  appendFileSync(join(dir, "a.txt"), "eight\nnine\n");
  writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 0, files: 2 }, "+2 appended, +1 new file");
  tracker.dispose();
});

test("real git: ignored files never count, binary untracked files are skipped", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\nbuild/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "ignore");
  const tracker = createGitChangesTracker({ getCwd: () => dir, intervalMs: 60_000 });
  await tracker.refresh();
  writeFileSync(join(dir, "ignored.txt"), "z\nz\nz\n");
  mkdirSync(join(dir, "build"));
  writeFileSync(join(dir, "build", "out.js"), "x\nx\nx\nx\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x0a]));
  writeFileSync(join(dir, "notes.md"), "a\nb\n");
  assert.deepEqual(await readChangeSample(dir, { rev: await resolveSessionRev(dir) }).then((r) => (r.kind === "sample" ? [...r.sample.untracked] : [])), [["notes.md", 2]]);
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 2, deletions: 0, files: 1 });
});

test("real git: churn counts work the session adds and then removes again", async (t) => {
  const dir = realRepo(t);
  const tracker = createGitChangesTracker({ getCwd: () => dir, intervalMs: 60_000 });
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "a clean start has no churn");

  // The session writes a 14-line probe (the shape of the reported bug: this
  // probe never reaches git history, so no state comparison can see it).
  const head = readFileSync(join(dir, "a.txt"), "utf8");
  const probe = Array.from({ length: 14 }, (_, i) => `probe ${i}`).join("\n") + "\n";
  writeFileSync(join(dir, "a.txt"), head + probe);
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 14, deletions: 0, files: 1 });

  // …then deletes it again, replacing it with 5 comment lines. A state
  // comparison reads +5 −0 here; the churn is +19 −14.
  writeFileSync(join(dir, "a.txt"), head + "// c1\n// c2\n// c3\n// c4\n// c5\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 19, deletions: 14, files: 1 }, "the 14 deletions survive their own removal");
  assert.deepEqual(tracker.session().state, { additions: 5, deletions: 0 }, "…while the work-tree state is still reported for reconciliation");

  // Deleting two of the session's own lines raises the deletion total: churn
  // never shrinks while the work tree is dirty.
  writeFileSync(join(dir, "a.txt"), head + "// c1\n// c2\n// c3\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 19, deletions: 16, files: 1 });

  // Committing the rest clears the totals (the tree is clean against HEAD).
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "comment");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "a commit clears the churn it captured");
  tracker.dispose();
});

test("real git: edits inside work that predates the session count exactly", async (t) => {
  const dir = realRepo(t);
  // Work in progress before the session: a.txt already differs from HEAD.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nTHREE\nFOUR\nfive\nsix\n");
  const tracker = createGitChangesTracker({ getCwd: () => dir, intervalMs: 60_000 });
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "pre-session work is the reference, not churn");
  assert.deepEqual(tracker.session().state, { additions: 4, deletions: 1 }, "…but it is still visible as the work-tree state");

  // Rewriting two of those pre-session lines and appending one: the old
  // HEAD-anchored subtraction reported +0 −0 for exactly this edit.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nTHREE\nFOUR2\nFIVE2\nfive\nsix\nseven\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 1, files: 1 });

  // Deleting a pre-session line counts as a deletion too.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nTHREE\nFOUR2\nFIVE2\nsix\nseven\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 2, files: 1 });
  tracker.dispose();
});

test("real git: an untracked file counts its growth and its later shrink", async (t) => {
  const dir = realRepo(t);
  const tracker = createGitChangesTracker({ getCwd: () => dir, intervalMs: 60_000 });
  await tracker.refresh();
  writeFileSync(join(dir, "notes.md"), "a\nb\nc\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 0, files: 1 }, "a new file counts its lines");
  // The same file loses a line: that is churn too, not a silent no-op.
  writeFileSync(join(dir, "notes.md"), "a\nc\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 1, files: 1 });
  tracker.dispose();
});
