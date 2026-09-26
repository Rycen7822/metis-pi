// Controlled command responses and tracker lifetime. Only .git discovery is real;
// Git execution is controlled; files use the real line-count cache during timer and in-flight races.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory as tempDir } from "../helpers/temp-dir.mjs";
import { trackedRepo } from "../helpers/git.mts";
import { GIT_CHANGES_DEBOUNCE_MS, readChangeSample, type GitExec } from "../../src/git-changes.ts";

/** Minimal repo marker so findGitDir() accepts the directory. */
function fakeRepo(t: TestContext): string {
  const dir = tempDir(t, "metis-pi-git-");
  mkdirSync(join(dir, ".git"));
  return dir;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function stubTracker(t: TestContext, lines: Record<string, number> = {}, intervalMs = 60_000) {
  type Response = string | undefined | (() => Promise<string>);
  const state = { cwd: fakeRepo(t), output: {
    "rev-parse --verify": "r\n",
    "rev-parse --show-object-format": "sha1\n",
    diff: "", "ls-files": "",
  } as Record<string, Response> };
  const exec = t.mock.fn<GitExec>(async ([command, option]) => {
    const response = state.output[command === "rev-parse" ? `${command} ${option}` : command];
    const stdout = typeof response === "function" ? await response() : response;
    return { ok: stdout !== undefined, stdout: stdout ?? "", code: stdout === undefined ? 128 : 0 };
  });
  const update = t.mock.fn();
  for (const [name, count] of Object.entries(lines)) writeFileSync(join(state.cwd, name), "line\n".repeat(count));
  const tracker = trackedRepo(t, state.cwd, { getCwd: () => state.cwd, exec, onUpdate: update, intervalMs });
  const calls = (command?: string) => exec.mock.calls.filter((call) => !command || call.arguments[0][0] === command).length;
  // Tests own both sides of a suspended command; dispose never releases it.
  const holdDiff = () => {
    let enter!: () => void;
    let release!: (diff: string) => void;
    const started = new Promise<void>((resolve) => { enter = resolve; });
    const result = new Promise<string>((resolve) => { release = resolve; });
    state.output.diff = () => { enter(); return result; };
    return { started, release };
  };
  return { state, tracker, exec, calls, holdDiff, updates: () => update.mock.callCount() };
}

for (const [name, rev, format, expectedRev] of [
  ["resolved HEAD", "abc123", undefined, "abc123"],
  ["unborn SHA-1", undefined, "sha1", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"],
  ["unborn SHA-256", undefined, "sha256", "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"],
  ["failed format query", undefined, undefined, undefined],
  ["unknown format", undefined, "sha3", undefined],
  ["empty format", undefined, "", undefined],
] as const) test(`readChangeSample: ${name} pins commands and parses tracked/untracked output`, async (t) => {
  const seen: string[] = [];
  const exec: GitExec = async (args) => {
    seen.push(args.join(" "));
    if (args[0] === "rev-parse") return { ok: format !== undefined, stdout: format ?? "", code: format === undefined ? 128 : 0 };
    return { ok: true, stdout: args[0] === "diff"
      ? "3\t1\tsrc/a.ts\0-\t-\tassets/logo.png\0" : "notes.md\0binary.bin\0" };
  };
  const cwd = fakeRepo(t);
  writeFileSync(join(cwd, "notes.md"), "one\ntwo\n");
  writeFileSync(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  const result = await readChangeSample(cwd, { exec, ...(rev ? { rev } : { unborn: true }) });
  assert.equal(result.kind, expectedRev ? "sample" : "error");
  assert.deepEqual(seen, [
    ...(rev ? [] : ["rev-parse --show-object-format"]),
    ...(expectedRev ? [`diff --numstat -z --no-ext-diff --no-textconv ${expectedRev}`, "ls-files --others --exclude-standard -z"] : []),
  ], "unresolved formats never guess an algorithm or run diff");
  if (result.kind === "sample") {
    assert.deepEqual([...result.sample.tracked], [
      ["src/a.ts", { additions: 3, deletions: 1 }],
      ["assets/logo.png", { additions: 0, deletions: 0 }],
    ]);
    assert.deepEqual([...result.sample.untracked], [["notes.md", 2]], "uncountable blobs are skipped");
  }
});

test("tracker: one sample owner survives read failures, HEAD changes and leaving the repo", async (t) => {
  const { state, tracker, calls, updates } = stubTracker(t, { "notes.md": 5 });
  for (const step of [
    { name: "first failed HEAD lookup leaves usage unknown", output: { "rev-parse --verify": undefined, diff: "1000\t0\ta.ts\0" },
      sample: undefined, rev: undefined, updates: 0 },
    { name: "initial tracked and untracked sample", output: { "rev-parse --verify": "rev1\n", diff: "11\t9\ta.ts\0", "ls-files": "notes.md\0" },
      sample: { additions: 16, deletions: 9, files: 2 }, rev: "rev1", updates: 1 },
    { name: "unchanged sample does not repaint", output: {},
      sample: { additions: 16, deletions: 9, files: 2 }, rev: "rev1", updates: 1 },
    { name: "failed diff preserves the last good sample", output: { diff: undefined },
      sample: { additions: 16, deletions: 9, files: 2 }, rev: "rev1", updates: 1 },
    { name: "successful retry replaces the sample", output: { diff: "3\t0\ta.ts\0", "ls-files": "" },
      sample: { additions: 3, deletions: 0, files: 1 }, rev: "rev1", updates: 2 },
    { name: "failed HEAD never treats a 1000-line tree as unborn", output: { "rev-parse --verify": undefined, diff: "1000\t0\ta.ts\0" },
      sample: { additions: 3, deletions: 0, files: 1 }, rev: "rev1", updates: 2 },
    { name: "HEAD recovery resumes real sampling", output: { "rev-parse --verify": "rev2\n" },
      sample: { additions: 1000, deletions: 0, files: 1 }, rev: "rev2", updates: 3 },
    { name: "a clean commit replaces the previous counts", output: { "rev-parse --verify": "rev3\n", diff: "" },
      sample: { additions: 0, deletions: 0, files: 0 }, rev: "rev3", updates: 4 },
  ]) {
    Object.assign(state.output, step.output);
    await tracker.refresh();
    assert.deepEqual(tracker.snapshot(), step.sample, step.name);
    assert.equal(tracker.session().rev, step.rev, step.name);
    assert.equal(updates(), step.updates, step.name);
  }
  const repoCalls = calls();
  state.cwd = tempDir(t, "metis-pi-norepo-");
  await tracker.refresh();
  assert.equal(tracker.snapshot(), undefined, "leaving the repo clears the segment");
  assert.equal(calls(), repoCalls, "a non-repo cwd spawns no git process");
  assert.equal(updates(), 5, "clearing the segment repaints");
});

test("tracker: polling, activity and coalesced reads share one disposable lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const { state, tracker, calls, updates, holdDiff } = stubTracker(t, {}, 1000);
  state.output.diff = "2\t0\ta.ts\n";
  tracker.touch();
  assert.equal(calls("diff"), 0, "touch before start is a no-op");
  tracker.start();
  await flush();
  assert.deepEqual(tracker.snapshot(), { additions: 2, deletions: 0, files: 1 });
  assert.equal(calls("diff"), 1, "start reads once");

  state.output.diff = "5\t0\ta.ts\n";
  tracker.touch();
  tracker.touch();
  t.mock.timers.tick(GIT_CHANGES_DEBOUNCE_MS - 10);
  await flush();
  assert.equal(calls("diff"), 1, "still inside the debounce window");
  t.mock.timers.tick(20);
  await flush();
  assert.deepEqual(tracker.snapshot(), { additions: 5, deletions: 0, files: 1 });
  assert.equal(calls("diff"), 2, "activity triggers a read");
  assert.equal(updates(), 2);

  state.output.diff = "9\t0\ta.ts\n";
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(tracker.snapshot(), { additions: 9, deletions: 0, files: 1 });
  assert.equal(calls("diff"), 3, "the interval polls independently of activity");

  for (const [dispose, diff, reads] of [[false, "1\t0\ta.ts\n", 4], [true, "7\t2\ta.ts\n", 5]] as const) {
    const gate = holdDiff();
    const pending = tracker.refresh();
    assert.equal(tracker.refresh(), pending, "concurrent refreshes join the in-flight read");
    await gate.started;
    assert.equal(calls("diff"), reads, "two refreshes add exactly one read");
    if (dispose) {
      tracker.dispose();
      assert.equal(tracker.snapshot(), undefined);
    }
    gate.release(diff);
    await pending;
    assert.deepEqual(tracker.snapshot(), dispose ? undefined : { additions: 1, deletions: 0, files: 1 });
    assert.equal(updates(), 4, "only the live owner publishes its completed read");
  }
  tracker.touch();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls("diff"), 5, "disposed tracker stops polling");
});
