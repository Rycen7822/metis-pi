// Current work tree vs HEAD, not accumulated edits. Parser/reader contracts,
// controlled tracker lifecycles, then real git in isolated temporary repos.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory as tempDir } from "../helpers/temp-dir.mjs";
import {
  createGitChangesTracker,
  createLineCountCache,
  GIT_CHANGES_DEBOUNCE_MS,
  MAX_UNTRACKED_BYTES,
  parseNumstatZ,
  parseUntracked,
  readChangeSample,
  readLineCount,
  resolveHead,
  type GitExec } from "../../src/git-changes.ts";

/** Minimal repo marker so findGitDir() accepts the directory. */
function fakeRepo(t: TestContext): string {
  const dir = tempDir(t, "metis-pi-git-");
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
  const dir = tempDir(t, "metis-pi-real-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** What git itself reports for the same question (tracked paths only). */
function gitDiffTotals(cwd: string, rev = "HEAD"): { additions: number; deletions: number; files: number } {
  const stdout = execFileSync("git", ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", rev], { cwd, encoding: "utf8" });
  const rows = parseNumstatZ(stdout);
  let additions = 0;
  let deletions = 0;
  for (const counts of rows.values()) {
    additions += counts.additions;
    deletions += counts.deletions;
  }
  return { additions, deletions, files: rows.size };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Line-count cache stub: fake repos have no files to stat. */
const fakeCounts = (lines: Record<string, number>) => ({
  count: async (path: string) => {
    const value = lines[path.split("/").pop()!];
    return value === undefined ? undefined : { lines: value, size: value, mtimeMs: 1 };
  },
  clear: () => { /* stub */ },
});

function trackedRepo(t: TestContext, cwd: string, deps: Partial<Parameters<typeof createGitChangesTracker>[0]> = {}) {
  const tracker = createGitChangesTracker({ getCwd: () => cwd, intervalMs: 60_000, ...deps });
  t.after(() => tracker.dispose());
  return tracker;
}

function stubTracker(t: TestContext, lines: Record<string, number> = {}, intervalMs = 60_000) {
  const state = { cwd: fakeRepo(t), output: { "rev-parse": "r\n", diff: "", "ls-files": "" } as Record<string, string | undefined> };
  const exec = t.mock.fn<GitExec>(async ([command]) => {
    const stdout = state.output[command];
    return { ok: stdout !== undefined, stdout: stdout ?? "", code: stdout === undefined ? 128 : 0 };
  });
  const update = t.mock.fn();
  const tracker = trackedRepo(t, state.cwd, { getCwd: () => state.cwd, exec, lineCounts: fakeCounts(lines), onUpdate: update, intervalMs });
  const calls = (command?: string) => exec.mock.calls.filter((call) => !command || call.arguments[0][0] === command).length;
  return { state, tracker, exec, calls, updates: () => update.mock.callCount() };
}

async function expectSample(tracker: ReturnType<typeof createGitChangesTracker>, additions: number, deletions: number, files: number) {
  await tracker.refresh();
  assert.deepEqual(tracker.snapshot(), { additions, deletions, files });
}

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

test("resolveHead: head, unborn and error are distinguished", async (t) => {
  const dir = realRepo(t);
  const head = await resolveHead(dir);
  assert.equal(head.kind, "head");
  assert.match(head.kind === "head" ? head.rev : "", /^[0-9a-f]{40}$/);
  const unborn = tempDir(t, "metis-pi-unborn-");
  git(unborn, "init", "-q");
  assert.deepEqual(await resolveHead(unborn), { kind: "unborn" }, "a live symbolic ref without commits");

  // No exit code (timeout, killed process, spawn failure): never read as unborn.
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: async () => ({ ok: false, stdout: "" }) }), { kind: "error" });
  const failing = (code: number | null, symref?: { ok: boolean; stdout: string }): GitExec => async (args) =>
    args[0] === "symbolic-ref" ? symref ?? { ok: false, stdout: "", code: 128 } : { ok: false, stdout: "", code };
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: failing(128) }), { kind: "error" }, "a general git failure");
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: failing(1) }), { kind: "error" }, "exit 1 but HEAD is not a live symref");
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: failing(1, { ok: true, stdout: "" }) }), { kind: "error" }, "symref without a branch name");
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: failing(1, { ok: true, stdout: "refs/heads/main\n" }) }), { kind: "unborn" });
  assert.deepEqual(await resolveHead(fakeRepo(t), { exec: async () => ({ ok: true, stdout: "", code: 0 }) }), { kind: "error" }, "success without an id");
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

test("readChangeSample diffs a resolved-unborn HEAD against the empty tree", async (t) => {
  const dir = fakeRepo(t);
  const seen: string[][] = [];
  const run = async (format: string | undefined) => {
    seen.length = 0;
    const exec: GitExec = async (args) => {
      seen.push([...args]);
      const key = args.join(" ");
      if (key === "rev-parse --show-object-format") {
        return format === undefined ? { ok: false, stdout: "", code: 128 } : { ok: true, stdout: `${format}\n`, code: 0 };
      }
      if (key.startsWith("diff --numstat -z")) return { ok: true, stdout: "3\t0\tstaged.txt\0", code: 0 };
      return { ok: true, stdout: "", code: 0 };
    };
    return await readChangeSample(dir, { exec, unborn: true, lineCounts: fakeCounts({}) });
  };
  const sha1 = await run("sha1");
  assert.equal(sha1.kind, "sample");
  assert.deepEqual(seen[1], ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]);
  const sha256 = await run("sha256");
  assert.equal(sha256.kind, "sample");
  assert.equal(seen[1]!.at(-1), "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321");
  // A failed or unknown format query is an error, never a guessed algorithm.
  assert.equal((await run(undefined)).kind, "error");
  assert.equal((await run("sha3")).kind, "error");
  assert.equal((await run("")).kind, "error");
});

test("readChangeSample without a resolved baseline reports an error", async (t) => {
  const dir = fakeRepo(t);
  const seen: string[] = [];
  const exec: GitExec = async (args) => {
    seen.push(args.join(" "));
    return { ok: true, stdout: "", code: 0 };
  };
  assert.equal((await readChangeSample(dir, { exec, lineCounts: fakeCounts({}) })).kind, "error");
  assert.equal((await readChangeSample(dir, { exec, rev: "", unborn: false, lineCounts: fakeCounts({}) })).kind, "error");
  assert.deepEqual(seen, [], "no git command runs without a known baseline");
});

test("tracker: publishes the current sample and replaces it on every read", async (t) => {
  const { state, tracker, updates } = stubTracker(t, { "notes.md": 5 });
  Object.assign(state.output, { "rev-parse": "rev1\n", diff: "11\t9\ta.ts\0", "ls-files": "notes.md\0" });
  await expectSample(tracker, 16, 9, 2);
  assert.deepEqual(tracker.session(), { rev: "rev1", observations: 1 });
  assert.equal(updates(), 1);

  await expectSample(tracker, 16, 9, 2);
  assert.equal(updates(), 1, "an unchanged sample publishes once");

  Object.assign(state.output, { diff: "3\t0\ta.ts\0", "ls-files": "" });
  await expectSample(tracker, 3, 0, 1);
  assert.deepEqual(tracker.session(), { rev: "rev1", observations: 3 });
  assert.equal(updates(), 2);

  Object.assign(state.output, { "rev-parse": "rev2\n", diff: "" });
  await expectSample(tracker, 0, 0, 0);
  assert.deepEqual(tracker.session(), { rev: "rev2", observations: 4 });
});

test("tracker: a failed read keeps the last good numbers", async (t) => {
  const { state, tracker } = stubTracker(t);
  state.output.diff = "4\t1\ta.ts\n";
  await expectSample(tracker, 4, 1, 1);
  state.output.diff = undefined;
  await expectSample(tracker, 4, 1, 1);
  state.output.diff = "2\t1\ta.ts\n";
  await expectSample(tracker, 2, 1, 1);
});

test("tracker: leaving a repo clears the segment without spawning git", async (t) => {
  const { state, tracker, calls, updates } = stubTracker(t);
  state.output.diff = "2\t0\ta.ts\n";
  await expectSample(tracker, 2, 0, 1);
  const repoCalls = calls();
  state.cwd = tempDir(t, "metis-pi-norepo-");
  await tracker.refresh();
  assert.equal(tracker.snapshot(), undefined, "no git metadata: nothing to show");
  assert.equal(calls(), repoCalls, "a non-repo cwd spawns no git process");
  assert.equal(updates(), 2, "clearing the segment repaints");
});

test("tracker: interval, activity refresh and dispose", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { state, tracker, calls, updates } = stubTracker(t, {}, 1000);
  state.output.diff = "2\t0\ta.ts\n";
  assert.equal(tracker.running, false);
  tracker.touch();
  assert.equal(calls("diff"), 0, "touch before start is a no-op");
  tracker.start();
  assert.equal(tracker.running, true);
  await expectSample(tracker, 2, 0, 1);
  assert.equal(calls("diff"), 1, "start reads once");

  state.output.diff = "5\t0\ta.ts\n";
  tracker.touch();
  tracker.touch();
  t.mock.timers.tick(GIT_CHANGES_DEBOUNCE_MS - 10);
  await flush();
  assert.equal(calls("diff"), 1, "still inside the debounce window");
  t.mock.timers.tick(20);
  await expectSample(tracker, 5, 0, 1);
  assert.equal(calls("diff"), 2, "activity triggers a read");
  assert.equal(updates(), 2);

  state.output.diff = "9\t0\ta.ts\n";
  t.mock.timers.tick(1000);
  await expectSample(tracker, 9, 0, 1);
  assert.equal(calls("diff"), 3, "the interval polls independently of activity");

  tracker.dispose();
  assert.equal(tracker.running, false);
  assert.equal(tracker.snapshot(), undefined);
  assert.deepEqual(tracker.session(), { rev: undefined, observations: 0 });
  tracker.touch();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls("diff"), 3, "disposed tracker stops polling");
});

test("tracker: concurrent refreshes coalesce onto one read", async (t) => {
  const dir = fakeRepo(t);
  let diffs = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse --verify")) return { ok: true, stdout: "r\n" };
    if (args[0] === "diff") {
      diffs += 1;
      await gate;
      return { ok: true, stdout: "1\t0\ta.ts\n" };
    }
    return { ok: true, stdout: "" };
  };
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts: fakeCounts({}), intervalMs: 60_000 });
  const first = tracker.refresh();
  const second = tracker.refresh();
  assert.equal(first, second, "the second call joins the in-flight read");
  release!();
  await first;
  assert.equal(diffs, 1, "one read for two refreshes");
  assert.deepEqual(tracker.snapshot(), { additions: 1, deletions: 0, files: 1 });
  tracker.dispose();
});

test("tracker: a read that finishes after dispose is discarded", async (t) => {
  const dir = fakeRepo(t);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse --verify")) return { ok: true, stdout: "r\n" };
    if (args[0] === "diff") {
      await gate;
      return { ok: true, stdout: "7\t2\ta.ts\n" };
    }
    return { ok: true, stdout: "" };
  };
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, lineCounts: fakeCounts({}), intervalMs: 60_000 });
  const pending = tracker.refresh();
  tracker.dispose();
  release!();
  await pending;
  assert.equal(tracker.snapshot(), undefined, "a late result does not resurrect a disposed tracker");
  assert.deepEqual(tracker.session(), { rev: undefined, observations: 0 });
});

test("tracker: a failed HEAD lookup keeps the last good sample", async (t) => {
  const { state, tracker, exec } = stubTracker(t);
  state.output.diff = "1\t0\ta.ts\0";
  await expectSample(tracker, 1, 0, 1);

  // A transient HEAD failure with a full 1000-line tree behind it: falling back
  // to the empty tree published 1001 additions here, which is the reported bug.
  Object.assign(state.output, { "rev-parse": undefined, diff: "1000\t0\ta.ts\0" });
  await expectSample(tracker, 1, 0, 1);
  assert.deepEqual(tracker.session(), { rev: "r", observations: 1 }, "the failed read does not count as a sample");

  // A tracker whose very first HEAD lookup fails shows nothing, not a fake 0.
  const fresh = trackedRepo(t, state.cwd, { exec, lineCounts: fakeCounts({}) });
  await fresh.refresh();
  assert.equal(fresh.snapshot(), undefined, "unknown until a read succeeds");

  state.output["rev-parse"] = "r\n";
  await expectSample(tracker, 1000, 0, 1);
});

test("real git: a damaged HEAD ref keeps the last good sample", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n"); // +1
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 1, 0, 1);
  const branch = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, ".git", branch), "not-a-sha\n");
  await expectSample(tracker, 1, 0, 1);
});

test("real git: existing WIP shows at once and unchanged reads never accumulate", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n"); // +2 −0 vs HEAD
  writeFileSync(join(dir, "notes.md"), "alpha\nbeta\ngamma\n");       // untracked, 3 lines
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 5, 0, 2);
  await expectSample(tracker, 5, 0, 2);

  // Rewrite like an agent would, then return to the old content: no history.
  for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, "a.txt"), `${"x".repeat(50)}\n`.repeat(1_000));
  await expectSample(tracker, 1_003, 3, 2);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  await expectSample(tracker, 5, 0, 2);

  // Reverting everything (tracked and untracked) clears the segment.
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  rmSync(join(dir, "notes.md"));
  await expectSample(tracker, 0, 0, 0);
});

test("real git: staged and unstaged changes count once against HEAD", async (t) => {
  const dir = realRepo(t);
  const file = join(dir, "a.txt");
  writeFileSync(file, "one\ntwo\nthree\nfour\n"); // unstaged +1
  git(dir, "add", "a.txt");                       // staged
  appendFileSync(file, "five\n");                 // a further unstaged +1
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 2, 0, 1);
  assert.deepEqual(tracker.snapshot(), gitDiffTotals(dir));

  // A staged NEW file counts its content and is not also listed as untracked.
  writeFileSync(join(dir, "staged.txt"), "a\nb\nc\n");
  git(dir, "add", "staged.txt");
  await expectSample(tracker, 5, 0, 2);
  assert.deepEqual(tracker.snapshot(), gitDiffTotals(dir));
});

test("real git: a partial commit lowers the numbers and keeps the other dirty file", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  git(dir, "add", "keep.txt");
  git(dir, "commit", "-q", "-m", "keep");
  writeFileSync(join(dir, "keep.txt"), "keep\npreexisting\n");          // +1, stays dirty
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");   // +2 −0
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 3, 0, 2);
  assert.deepEqual(tracker.snapshot(), gitDiffTotals(dir));

  // Commit only a.txt: the reported bug kept the committed +2 folded into the
  // totals (+3), so the other dirty file alone is what must remain.
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "partial");
  await expectSample(tracker, 1, 0, 1);
  assert.deepEqual(tracker.snapshot(), gitDiffTotals(dir));
  await expectSample(tracker, 1, 0, 1);
});

test("real git: a staged rename reports git's diff, not a phantom deletion", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, "long.txt"), `${"line\n".repeat(999)}extra\n`);
  git(dir, "add", "long.txt");
  git(dir, "commit", "-q", "-m", "long");
  // Work in progress before the session: one appended line.
  writeFileSync(join(dir, "long.txt"), `${"line\n".repeat(999)}extra\nwip\n`);
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 1, 0, 1);

  // Rename and stage: git pairs the paths, so the 1000 unchanged lines are not
  // a 1000-line deletion (the old per-path baseline reported +1 −1001 here).
  renameSync(join(dir, "long.txt"), join(dir, "renamed.txt"));
  git(dir, "add", "-A");
  await expectSample(tracker, 1, 0, 1);
  assert.deepEqual(tracker.snapshot(), gitDiffTotals(dir));
});

test("real git: untracked text counts; ignored, binary and oversized do not", async (t) => {
  const dir = realRepo(t);
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-q", "-m", "ignore");
  writeFileSync(join(dir, "ignored.txt"), "x\ny\nz\n");
  writeFileSync(join(dir, "text.md"), "a\nb\nc\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([0x50, 0x00, 0x51, 0x0a]));
  writeFileSync(join(dir, "huge.txt"), "x".repeat(MAX_UNTRACKED_BYTES + 1));
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 3, 0, 1);

  // A tracked deletion counts its lines; a tracked binary change counts as a
  // file with no line counts — exactly what git reports.
  rmSync(join(dir, "a.txt"));
  writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2]));
  git(dir, "add", "b.bin");
  git(dir, "commit", "-q", "-m", "bin");
  writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1, 2, 3]));
  await expectSample(tracker, 3, 3, 3); // −3 a.txt, 0/0 b.bin, +3 text.md
});

test("real git: an unborn HEAD counts staged new files and their unstaged edits", async (t) => {
  const dir = tempDir(t, "metis-pi-unborn-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "staged.txt"), "a\nb\nc\n");
  git(dir, "add", "staged.txt");                     // staged new file
  appendFileSync(join(dir, "staged.txt"), "d\ne\n"); // unstaged edits on top
  writeFileSync(join(dir, "untracked.txt"), "x\ny\n");
  const tracker = trackedRepo(t, dir);
  await expectSample(tracker, 7, 0, 2);
  assert.equal(tracker.session().rev, undefined, "no HEAD yet");

  // Staging the rest does not change the work-tree sample.
  git(dir, "add", "staged.txt");
  await expectSample(tracker, 7, 0, 2);

  // The first commit turns the empty-tree baseline into a real HEAD.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  await expectSample(tracker, 0, 0, 0);
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
