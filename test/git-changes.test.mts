// git-changes.test.mts — the footer's working-tree change counts (+A −D).
// Two layers: the pure parsers/guards, and the tracker that polls them. The last
// case runs real git in a temp repo, so the exact command contract
// (`diff --numstat HEAD` + `ls-files --others --exclude-standard -z`) is pinned.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countLines,
  createGitChangesTracker,
  findGitDir,
  MAX_UNTRACKED_BYTES,
  parseNumstat,
  parseUntracked,
  readChangeFile,
  readGitChanges,
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("numstat rows sum line counts, binary rows count as files only", () => {
  assert.deepEqual(parseNumstat(""), { additions: 0, deletions: 0, files: 0 });
  assert.deepEqual(parseNumstat("3\t1\tsrc/a.ts\n"), { additions: 3, deletions: 1, files: 1 });
  assert.deepEqual(parseNumstat("-\t-\tassets/logo.png\n12\t0\tnew.txt\n"), { additions: 12, deletions: 0, files: 2 });
  assert.deepEqual(parseNumstat("1\t2\told.ts => new.ts\n"), { additions: 1, deletions: 2, files: 1 });
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

test("readChangeFile skips binary and oversized blobs, reads text", (t) => {
  const dir = tempDir(t, "pi-codexy-read-");
  const text = join(dir, "text.txt");
  writeFileSync(text, "a\nb\n");
  assert.equal(readChangeFile(text)?.toString("utf8"), "a\nb\n");
  const binary = join(dir, "binary.bin");
  writeFileSync(binary, Buffer.from([0x50, 0x00, 0x51]));
  assert.equal(readChangeFile(binary), undefined);
  const huge = join(dir, "huge.txt");
  writeFileSync(huge, "x".repeat(MAX_UNTRACKED_BYTES + 1));
  assert.equal(readChangeFile(huge), undefined);
  assert.equal(readChangeFile(join(dir, "missing.txt")), undefined);
  assert.equal(readChangeFile(dir), undefined);
});

test("readGitChanges adds untracked line counts to the tracked numstat", async (t) => {
  const dir = fakeRepo(t);
  const exec: GitExec = async (args) => {
    const key = args.join(" ");
    if (key === "diff --numstat HEAD") return { ok: true, stdout: "3\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n" };
    if (key === "ls-files --others --exclude-standard -z") return { ok: true, stdout: "notes.md\0binary.bin\0" };
    return { ok: false, stdout: "" };
  };
  const read = (path: string) => (path.endsWith("notes.md") ? Buffer.from("x\ny\n") : undefined);
  // 2 tracked files (one binary) + 1 countable untracked file; the unreadable
  // untracked blob is skipped rather than counted as zero.
  assert.deepEqual(await readGitChanges(dir, { exec, readFile: read }), { additions: 5, deletions: 1, files: 3 });
});

test("readGitChanges degrades to the readable half and reports nothing outside a repo", async (t) => {
  const dir = fakeRepo(t);
  const partial = await readGitChanges(dir, {
    exec: async (args) => (args.join(" ") === "diff --numstat HEAD" ? { ok: true, stdout: "2\t0\ta.ts\n" } : { ok: false, stdout: "" }),
  });
  assert.deepEqual(partial, { additions: 2, deletions: 0, files: 1 });
  const empty = await readGitChanges(dir, { exec: async () => ({ ok: false, stdout: "" }) });
  assert.deepEqual(empty, { additions: 0, deletions: 0, files: 0 }, "no readable half → zeroed, never undefined mid-repo");
  assert.equal(await readGitChanges(tempDir(t, "pi-codexy-nogit-")), undefined, "no git metadata → nothing to show");
  assert.equal(findGitDir(""), undefined);
});

test("tracker polls on its interval and notifies only when the numbers change", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = fakeRepo(t);
  let additions = 2;
  let reads = 0;
  let updates = 0;
  const exec: GitExec = async (args) => {
    if (args.join(" ") === "diff --numstat HEAD") {
      reads += 1;
      return { ok: true, stdout: `${additions}\t0\ta.ts\n` };
    }
    return { ok: true, stdout: "" };
  };
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, onUpdate: () => { updates += 1; }, intervalMs: 1000 });
  assert.equal(tracker.running, false);
  tracker.start();
  assert.equal(tracker.running, true);
  await flush();
  assert.deepEqual(tracker.snapshot(), { additions: 2, deletions: 0, files: 1 });
  assert.equal(updates, 1, "first read publishes");

  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 2, "interval re-reads");
  assert.equal(updates, 1, "identical numbers do not repaint");

  additions = 5;
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(tracker.snapshot(), { additions: 5, deletions: 0, files: 1 });
  assert.equal(updates, 2, "changed numbers repaint");

  tracker.dispose();
  assert.equal(tracker.running, false);
  assert.equal(tracker.snapshot(), undefined);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, 3, "disposed tracker stops polling");
});

test("tracker coalesces concurrent refreshes and drops a read that lands after dispose", async (t) => {
  const dir = fakeRepo(t);
  let release: ((value: { ok: boolean; stdout: string }) => void) | undefined;
  let reads = 0;
  const exec: GitExec = async (args) => {
    if (args.join(" ") !== "diff --numstat HEAD") return { ok: true, stdout: "" };
    reads += 1;
    return await new Promise((resolve) => { release = resolve; });
  };
  let updates = 0;
  const tracker = createGitChangesTracker({ getCwd: () => dir, exec, onUpdate: () => { updates += 1; } });
  const first = tracker.refresh();
  const second = tracker.refresh();
  assert.equal(reads, 1, "in-flight read is reused");
  tracker.dispose();
  release?.({ ok: true, stdout: "9\t9\ta.ts\n" });
  await Promise.all([first, second]);
  assert.deepEqual(tracker.snapshot(), undefined, "late read must not resurrect the stat");
  assert.equal(updates, 0);
});

test("real git: work tree vs HEAD plus untracked, ignored files excluded", async (t) => {
  const dir = tempDir(t, "pi-codexy-real-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");

  writeFileSync(join(dir, "a.txt"), "one\nthree\nfour\n"); // -1 +2
  writeFileSync(join(dir, "b.txt"), "x\ny\n");             // untracked, 2 lines
  writeFileSync(join(dir, "ignored.txt"), "z\nz\nz\n");    // ignored → not counted

  assert.deepEqual(await readGitChanges(dir), { additions: 4, deletions: 1, files: 2 });
});
