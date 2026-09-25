// codex-todo tools + commands tests — fake pi host, tmpdir store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTodoStore } from "../../src/todo/store.ts";
import { createTodoToolHandlers, renderListText, type CodexTodoSystem } from "../../src/todo/tools.ts";

const makeSystem = (dir: string) => {
  let turn = 3;
  let changedCount = 0;
  const system: CodexTodoSystem = {
    store: openTodoStore(dir),
    turn: () => turn,
    changed: () => { changedCount += 1; },
  };
  return { system, turns: { bump: () => { turn += 1; } }, changed: () => changedCount };
};

test("reparented task depths follow the hierarchy rather than creation order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-depth-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "early child" }, { title: "later parent" }, { title: "root" }] }, "s");
    await exec({ action: "update", id: "2", parentId: "3" }, "s");
    await exec({ action: "update", id: "1", parentId: "2.1" }, "s");
    const list = (await exec({ action: "list" }, "s")).content[0].text;
    assert.match(list, /\n○ root\n  ○ later parent\n    ○ early child\nnext: #1\.1$/);
    assert.deepEqual(system.store.read().tasks.map((task) => task.id), [1, 2, 3], "rendering must not reorder stored tasks");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compound updates preserve write notifications and a saved title when the move fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-update-"));
  try {
    const { system, changed } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }, { title: "child", parentId: "1" }] }, "s");
    const moved = await exec({ action: "update", id: "1.1", title: "child", parentId: "2" }, "s");
    assert.equal(moved.content[0].text, "updated #2.1");
    assert.equal(changed(), 3);
    const renamed = await exec({ action: "update", id: "2.1", title: "renamed", parentId: "2" }, "s");
    assert.equal(renamed.content[0].text, "updated #2.1");
    assert.equal(changed(), 5);
    const unchanged = await exec({ action: "update", id: "2.1", title: "renamed", parentId: "2" }, "s");
    assert.equal(unchanged.content[0].text, "updated #2.1");
    assert.equal(changed(), 7);
    const empty = await exec({ action: "update", id: "2.1" }, "s");
    assert.match(empty.content[0].text, /^No change:/);
    assert.equal(changed(), 7);
    await assert.rejects(exec({ action: "update", id: "2.1", title: "saved", parentId: "2.1" }, "s"), /own parent/);
    assert.equal(system.store.read().tasks.at(-1)?.title, "saved", "title is persisted before the independent move");
    assert.equal(changed(), 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency changes preserve paths, no-op handling and mutation notifications", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-dependency-"));
  try {
    const { system, changed } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }] }, "s");
    for (const [action, phrase, dependencies] of [
      ["addBlockedBy", "now", [2]], ["removeBlockedBy", "no longer", []],
    ] as const) {
      const result = await exec({ action, id: "1", blockedBy: "2" }, "s");
      assert.equal(result.content[0].text, `#1 is ${phrase} blocked by #2`);
      assert.deepEqual(system.store.read().tasks[0].blockedBy, dependencies);
      const before = changed();
      const noop = await exec({ action, id: "1", blockedBy: "2" }, "s");
      assert.match(noop.content[0].text, /^no change:/);
      assert.equal(changed(), before);
    }
    assert.equal(changed(), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("add returns created ids and fires changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system, changed } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    const r = await exec({ action: "add", tasks: [{ title: "plan schema" }, { title: "write store", parentId: 1 }] }, "sess-A");
    assert.match(r.content[0].text, /added 2 task\(s\): #1 plan schema, #1\.1 write store/, "a subtask is numbered #1.1, not #2");
    assert.equal(changed(), 1);
    const list = await exec({ action: "list" }, "sess-A");
    assert.match(list.content[0].text, /Todos: 0\/2 done/);
    assert.match(list.content[0].text, /○ plan schema/); // ids hidden until a blockedBy edge exists
    assert.match(list.content[0].text, /○ write store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation errors throw with self-correcting messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "parent" }, { title: "child", parentId: 1 }] }, "s");
    await assert.rejects(() => exec({ action: "add", tasks: [{ title: "PARENT" }] }, "s"), /duplicate title/);
    await assert.rejects(() => exec({ action: "claim", id: 99 }, "s"), /not found/);
    // The completion gate blocks BOTH unfinished subtasks and missing evidence.
    await assert.rejects(() => exec({ action: "complete", id: 1, evidence: "done" }, "s"), /unfinished subtasks/);
    await assert.rejects(() => exec({ action: "complete", id: "1.1" }, "s"), /evidence required/);
    await exec({ action: "complete", id: "1.1", evidence: "child done" }, "s");
    const ok = await exec({ action: "complete", id: 1, evidence: "all done" }, "s");
    assert.match(ok.content[0].text, /completed #1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim/release ownership with force path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    await exec({ action: "claim", id: 1 }, "agent-A");
    await assert.rejects(() => exec({ action: "release", id: 1 }, "agent-B"), /force to override/);
    await assert.rejects(() => exec({ action: "claim", id: 1 }, "agent-B"), /retry with force/);
    const forced = await exec({ action: "claim", id: 1, force: true }, "agent-B");
    assert.match(forced.content[0].text, /claimed #1 for agent-B/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete gates on evidence files existing on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }] }, "s");
    writeFileSync(join(dir, "proof.txt"), "ok", "utf8");
    await assert.rejects(
      () => exec({ action: "complete", id: 1, evidence: "done", evidenceFiles: ["missing.txt"] }, "s"),
      /evidence files do not exist — missing\.txt/,
    );
    const ok = await exec({ action: "complete", id: 1, evidence: "proof written", evidenceFiles: ["proof.txt"] }, "s");
    assert.match(ok.content[0].text, /completed #1/);
    const state = system.store.read();
    assert.equal(state.tasks[0].evidence, "proof written");
    assert.equal(state.tasks[0].completedAtTurn, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderListText shows claims and next suggestion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "a" }, { title: "b" }, { title: "c" }] }, "s");
    await exec({ action: "claim", id: 2 }, "agent-X");
    const text = renderListText(system.store.read(), "s");
    assert.match(text, /○ a/);
    assert.match(text, /◐ b \[agent-X\]/);
    assert.match(text, /next: #1/);
    const mine = renderListText(system.store.read(), "agent-X");
    assert.match(mine, /\[mine\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adding to a finished list starts a new list instead of appending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-tools-"));
  try {
    const { system } = makeSystem(dir);
    const exec = createTodoToolHandlers(system, () => dir);
    await exec({ action: "add", tasks: [{ title: "old a" }, { title: "old b" }] }, "s");
    await exec({ action: "complete", id: 1, evidence: "shipped" }, "s");
    await exec({ action: "complete", id: 2, evidence: "shipped" }, "s");

    // While a task is still live, add keeps extending the same list.
    const reopened = await exec({ action: "reopen", id: 2 }, "s");
    assert.match(reopened.content[0].text, /reopened/);
    const appended = await exec({ action: "add", tasks: [{ title: "follow-up" }] }, "s");
    assert.match(appended.content[0].text, /added 1 task\(s\): #3 follow-up/);
    assert.doesNotMatch(appended.content[0].text, /new list/);

    // Once every task is closed, the list is history: the next add starts over.
    await exec({ action: "complete", id: 2, evidence: "shipped" }, "s");
    await exec({ action: "complete", id: 3, evidence: "shipped" }, "s");
    const fresh = await exec({ action: "add", tasks: [{ title: "new work" }] }, "s");
    assert.match(fresh.content[0].text, /added 1 task\(s\): #1 new work \(new list: 3 finished task\(s\) cleared; ids restart at #1/);
    const list = await exec({ action: "list" }, "s");
    assert.match(list.content[0].text, /Todos: 0\/1 done/);
    assert.match(list.content[0].text, /new work/);
    assert.doesNotMatch(list.content[0].text, /old a|old b|follow-up/, "the finished list is gone, not shown as history");

    // Paths are unique only within a list, and the restart note above is the
    // guard: a path the new list does not have still fails loudly, and the error
    // teaches the paths that do exist.
    await assert.rejects(
      () => exec({ action: "complete", id: "2", evidence: "shipped" }, "s"),
      /task #2 not found — current paths: #1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
