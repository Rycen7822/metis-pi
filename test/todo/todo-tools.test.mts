// Real tmpdir store and tool handlers; no host settings or user task lists.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { openTodoStore } from "../../src/todo/store.ts";
import { createTodoToolHandlers, renderListText } from "../../src/todo/tools.ts";

function setup(t: TestContext) {
  const dir = temporaryDirectory(t);
  const store = openTodoStore(dir);
  t.after(() => store.dispose());
  const changed = t.mock.fn();
  const execute = createTodoToolHandlers({ store, turn: () => 3, changed }, () => dir);
  const exec = async (args: Parameters<typeof execute>[0], session = "s") => (await execute(args, session)).content[0].text;
  return { dir, store, exec, changes: () => changed.mock.callCount() };
}

test("reparented task depths follow the hierarchy rather than creation order", async (t) => {
  const { store, exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "early child" }, { title: "later parent" }, { title: "root" }] });
  await exec({ action: "update", id: "2", parentId: "3" });
  await exec({ action: "update", id: "1", parentId: "2.1" });
  assert.match(await exec({ action: "list" }), /\n○ root\n  ○ later parent\n    ○ early child\nnext: #1\.1$/);
  assert.deepEqual(store.read().tasks.map((task) => task.id), [1, 2, 3], "rendering cannot reorder stored tasks");
});

test("compound updates preserve notifications and a saved title when the move fails", async (t) => {
  const { store, exec, changes } = setup(t);
  await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }, { title: "child", parentId: "1" }] });
  for (const [id, title, count] of [["1.1", "child", 3], ["2.1", "renamed", 5], ["2.1", "renamed", 7]] as const) {
    assert.equal(await exec({ action: "update", id, title, parentId: "2" }), "updated #2.1");
    assert.equal(changes(), count);
  }
  assert.match(await exec({ action: "update", id: "2.1" }), /^No change:/);
  assert.equal(changes(), 7);
  await assert.rejects(exec({ action: "update", id: "2.1", title: "saved", parentId: "2.1" }), /own parent/);
  assert.equal(store.read().tasks.at(-1)?.title, "saved", "title persists before the independent move");
  assert.equal(changes(), 8);
});

test("dependency changes preserve paths, no-op handling and mutation notifications", async (t) => {
  const { store, exec, changes } = setup(t);
  await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }] });
  for (const [action, phrase, dependencies] of [
    ["addBlockedBy", "now", [2]], ["removeBlockedBy", "no longer", []],
  ] as const) {
    assert.equal(await exec({ action, id: "1", blockedBy: "2" }), `#1 is ${phrase} blocked by #2`);
    assert.deepEqual(store.read().tasks[0].blockedBy, dependencies);
    const before = changes();
    assert.match(await exec({ action, id: "1", blockedBy: "2" }), /^no change:/);
    assert.equal(changes(), before);
  }
  assert.equal(changes(), 3);
});

test("add returns created paths and fires changed", async (t) => {
  const { exec, changes } = setup(t);
  const added = await exec({ action: "add", tasks: [{ title: "plan schema" }, { title: "write store", parentId: 1 }] }, "sess-A");
  assert.match(added, /added 2 task\(s\): #1 plan schema, #1\.1 write store/);
  assert.equal(changes(), 1);
  assert.match(await exec({ action: "list" }, "sess-A"), /Todos: 0\/2 done[\s\S]*○ plan schema[\s\S]*○ write store/);
});

test("validation errors throw with self-correcting messages", async (t) => {
  const { exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "parent" }, { title: "child", parentId: 1 }] });
  const failures: [Parameters<typeof exec>[0], RegExp][] = [
    [{ action: "add", tasks: [{ title: "PARENT" }] }, /duplicate title/],
    [{ action: "claim", id: 99 }, /not found/],
    [{ action: "complete", id: 1, evidence: "done" }, /unfinished subtasks/],
    [{ action: "complete", id: "1.1" }, /evidence required/],
  ];
  for (const [args, error] of failures) await assert.rejects(exec(args), error);
  await exec({ action: "complete", id: "1.1", evidence: "child done" });
  assert.match(await exec({ action: "complete", id: 1, evidence: "all done" }), /completed #1/);
});

test("claim/release ownership with force path", async (t) => {
  const { exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "a" }] });
  await exec({ action: "claim", id: 1 }, "agent-A");
  await assert.rejects(exec({ action: "release", id: 1 }, "agent-B"), /force to override/);
  await assert.rejects(exec({ action: "claim", id: 1 }, "agent-B"), /retry with force/);
  assert.match(await exec({ action: "claim", id: 1, force: true }, "agent-B"), /claimed #1 for agent-B/);
});

test("complete gates on evidence files existing on disk", async (t) => {
  const { dir, store, exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "a" }] });
  writeFileSync(join(dir, "proof.txt"), "ok", "utf8");
  await assert.rejects(exec({ action: "complete", id: 1, evidence: "done", evidenceFiles: ["missing.txt"] }), /evidence files do not exist — missing\.txt/);
  assert.match(await exec({ action: "complete", id: 1, evidence: "proof written", evidenceFiles: ["proof.txt"] }), /completed #1/);
  assert.equal(store.read().tasks[0].evidence, "proof written");
  assert.equal(store.read().tasks[0].completedAtTurn, 3);
});

test("renderListText shows claims and next suggestion", async (t) => {
  const { store, exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] });
  await exec({ action: "claim", id: 2 }, "agent-X");
  assert.match(renderListText(store.read(), "s"), /○ a[\s\S]*◐ b \[agent-X\][\s\S]*next: #1/);
  assert.match(renderListText(store.read(), "agent-X"), /\[mine\]/);
});

test("adding to a finished list starts a new list instead of appending", async (t) => {
  const { exec } = setup(t);
  await exec({ action: "add", tasks: [{ title: "old a" }, { title: "old b" }] });
  for (const id of [1, 2]) await exec({ action: "complete", id, evidence: "shipped" });
  assert.match(await exec({ action: "reopen", id: 2 }), /reopened/);
  const appended = await exec({ action: "add", tasks: [{ title: "follow-up" }] });
  assert.match(appended, /added 1 task\(s\): #3 follow-up/);
  assert.doesNotMatch(appended, /new list/);
  for (const id of [2, 3]) await exec({ action: "complete", id, evidence: "shipped" });
  assert.match(await exec({ action: "add", tasks: [{ title: "new work" }] }), /added 1 task\(s\): #1 new work \(new list: 3 finished task\(s\) cleared; ids restart at #1/);
  const list = await exec({ action: "list" });
  assert.match(list, /Todos: 0\/1 done[\s\S]*new work/);
  assert.doesNotMatch(list, /old a|old b|follow-up/);
  await assert.rejects(exec({ action: "complete", id: "2", evidence: "shipped" }), /task #2 not found — current paths: #1/);
});
