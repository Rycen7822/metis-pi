// Literal parser and HEAD decision contracts; no filesystem or child processes.
import test from "node:test";
import assert from "node:assert/strict";
import { parseNumstatZ, resolveHead, type GitExec } from "../../src/git-changes.ts";

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

test("resolveHead: injected failures require positive evidence before reporting unborn", async () => {
  assert.deepEqual(await resolveHead("/unused-repo", { exec: async () => ({ ok: false, stdout: "" }) }), { kind: "error" });
  const failing = (code: number | null, symref?: { ok: boolean; stdout: string }): GitExec => async (args) =>
    args[0] === "symbolic-ref" ? symref ?? { ok: false, stdout: "", code: 128 } : { ok: false, stdout: "", code };
  assert.deepEqual(await resolveHead("/unused-repo", { exec: failing(128) }), { kind: "error" }, "a general git failure");
  assert.deepEqual(await resolveHead("/unused-repo", { exec: failing(1) }), { kind: "error" }, "exit 1 but HEAD is not a live symref");
  assert.deepEqual(await resolveHead("/unused-repo", { exec: failing(1, { ok: true, stdout: "" }) }), { kind: "error" }, "symref without a branch name");
  assert.deepEqual(await resolveHead("/unused-repo", { exec: failing(1, { ok: true, stdout: "refs/heads/main\n" }) }), { kind: "unborn" });
  assert.deepEqual(await resolveHead("/unused-repo", { exec: async () => ({ ok: true, stdout: "", code: 0 }) }), { kind: "error" }, "success without an id");
});
