// git-changes.test.mts — the footer's session change counts (+A −D).
// Three layers: the pure parsers/stat math, the reader (pinned git contract),
// and the tracker. The last cases run real git in a temp repo — including a
// mid-session commit and a script-style edit — because the whole point of
// 0.13.0 is that the counts are the SESSION's absolute additions/deletions,
// never a worktree-vs-HEAD snapshot or a net line delta.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countLines,
  createGitChangesTracker,
  createLineCountCache,
  findGitDir,
  GIT_CHANGES_DEBOUNCE_MS,
  MAX_UNTRACKED_BYTES,
  parseNumstatZ,
  parseUntracked,
  readChangeSample,
  readLineCount,
  resolveSessionRev,
  sessionChangeStat,
  type ChangeSample,
  type GitExec,
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

test("line counting matches git: trailing newline, no trailing newline, empty", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("\n"), 1);
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

test("sessionChangeStat subtracts the baseline per path and never goes negative", () => {
  // Pre-existing work at session start (baseline) is not the session's work.
  const baseline = sample([["a.ts", 11, 9], ["pre.ts", 50, 0]], [["notes.md", 20]]);
  assert.deepEqual(sessionChangeStat(baseline, baseline), { additions: 0, deletions: 0, files: 0 });

  // The user's case: A +11 −9 and B +6 −5 must read +17 −14, not +3 −0.
  const edited = sample([["a.ts", 22, 18], ["b.ts", 6, 5]], [["notes.md", 20]]);
  assert.deepEqual(sessionChangeStat(edited, baseline), { additions: 17, deletions: 14, files: 2 });

  // A file the session never touched contributes nothing, even after commits
  // (its counts move to HEAD and drop out of the diff).
  assert.deepEqual(sessionChangeStat(sample([["pre.ts", 0, 0]]), baseline), { additions: 0, deletions: 0, files: 0 });
  // Reverting someone else's pending edit: clamped, not negative.
  assert.deepEqual(sessionChangeStat(sample([["pre.ts", 0, 0]]), sample([["pre.ts", 50, 0]])), { additions: 0, deletions: 0, files: 0 });
  // Files the session created count fully; baselined untracked files count only
  // what they gained.
  assert.deepEqual(
    sessionChangeStat(sample([], [["notes.md", 26], ["new.md", 7]]), baseline),
    { additions: 13, deletions: 0, files: 2 },
  );
  // An untracked file that the session COMMITS: its baseline lines are still
  // not the session's, only the growth beyond them is.
  assert.deepEqual(
    sessionChangeStat(sample([["notes.md", 24, 0]], []), baseline),
    { additions: 4, deletions: 0, files: 1 },
  );
  // A file that was tracked at the baseline and is untracked now (git rm
  // --cached) predates the session: credited with nothing.
  assert.deepEqual(
    sessionChangeStat(sample([], [["pre.ts", 50]]), baseline),
    { additions: 0, deletions: 0, files: 0 },
  );
  // A plain read with no baseline yet: everything is the session's (the
  // tracker's very first read is the baseline itself, so this is only the
  // degenerate call).
  assert.deepEqual(sessionChangeStat(sample([["x.ts", 2, 1]]), undefined), { additions: 2, deletions: 1, files: 1 });
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
  let tracked = "11\t9\ta.ts\0";       // work in progress when the session starts
  let untracked = "notes.md\0";
  let updates = 0;
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return { ok: true, stdout: "rev1\n" };
    if (key.startsWith("diff --numstat -z")) return { ok: true, stdout: tracked };
    if (key === "ls-files --others --exclude-standard -z") return { ok: true, stdout: untracked };
    return { ok: false, stdout: "" };
  };
  const lineCounts = fakeCounts({ "notes.md": 5, "fresh.md": 5 });
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts, onUpdate: () => { updates += 1; } });
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 }, "pre-existing work is the baseline");
  assert.deepEqual(tracker.session(), { rev: "rev1", baseline: true });
  assert.equal(updates, 1, "the baseline publishes once (0/0 hides the segment)");

  tracked = ["22\t18\ta.ts", "6\t5\tb.ts"].join("\0") + "\0";   // +11 −9 in A, +6 −5 in B
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 17, deletions: 14, files: 2 });
  assert.equal(updates, 2);

  // A commit mid-session does not move the numbers: the read diffs against the
  // revision the SESSION started from, so git keeps reporting the same rows.
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 17, deletions: 14, files: 2 }, "a commit never erases session progress");
  assert.equal(updates, 2, "unchanged numbers do not repaint");

  // Undoing the work (git checkout / stash / the agent reverting itself) does
  // report nothing: the numbers are the session's diff against its own start.
  tracked = "";
  untracked = "";
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 0, deletions: 0, files: 0 });

  // New work after that counts against the same baseline again, and a file the
  // session creates counts its whole content.
  tracked = "22\t18\ta.ts\0";
  untracked = ["notes.md", "fresh.md"].join("\0") + "\0";
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 16, deletions: 9, files: 2 }, "+11 −9 tracked, +5 for the new file");

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
  await flush();
  assert.equal(reads, 1, "start reads once for the baseline");

  // Activity-driven refresh: debounced, then a real read.
  additions = 5;
  tracker.touch();
  tracker.touch();
  t.mock.timers.tick(GIT_CHANGES_DEBOUNCE_MS - 10);
  await flush();
  assert.equal(reads, 1, "still inside the debounce window");
  t.mock.timers.tick(20);
  await flush();
  assert.equal(reads, 2, "activity triggers a read");
  assert.deepEqual(tracker.snapshot(), { additions: 3, deletions: 0, files: 1 });
  assert.equal(updates, 2);

  // The interval keeps polling independently of activity.
  additions = 9;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 3);
  assert.deepEqual(tracker.snapshot(), { additions: 7, deletions: 0, files: 1 });

  tracker.dispose();
  assert.equal(tracker.running, false);
  assert.equal(tracker.snapshot(), undefined);
  assert.deepEqual(tracker.session(), { rev: undefined, baseline: false });
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

test("real git: session deltas survive a commit and count script-made edits", async (t) => {
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

  // A mid-session commit moves the changes into HEAD: the session totals stay.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "mid-session");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 7, deletions: 1, files: 2 });

  // …and later edits keep adding to the same absolute totals.
  appendFileSync(join(dir, "a.txt"), "eight\nnine\n");
  writeFileSync(join(dir, "new.ts"), "export const x = 1;\n");
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions: 10, deletions: 1, files: 3 });
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
