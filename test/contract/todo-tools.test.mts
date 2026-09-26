// Tool mapping and notifications use real model functions through read/mutate.
// Disk persistence and evidence-file checks belong to the IO suite.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { todoState } from "../helpers/todo.mts";
import { createTodoToolHandlers, type CodexTodoSystem } from "../../src/todo/tools.ts";

function setup(t: TestContext, state = todoState()) {
  const store: CodexTodoSystem["store"] = {
    read: () => structuredClone(state),
    async mutate(fn) {
      const result = fn(structuredClone(state));
      if (result.ok) state = result.state;
      return result;
    },
  };
  const changed = t.mock.fn();
  const execute = createTodoToolHandlers({ store, turn: () => 3, changed }, () => "/unused-tool-cwd");
  const exec = async (args: Parameters<typeof execute>[0], session = "s") => (await execute(args, session)).content[0].text;
  return { store, exec, changes: () => changed.mock.callCount() };
}

test("compound updates preserve notifications and a saved title when the move fails", async (t) => {
  const { store, exec, changes } = setup(t, todoState("a", "b", { title: "child", parentId: 1 }));
  for (const [id, title, count] of [["1.1", "child", 2], ["2.1", "renamed", 4], ["2.1", "renamed", 6]] as const) {
    assert.equal(await exec({ action: "update", id, title, parentId: "2" }), "updated #2.1");
    assert.equal(changes(), count);
  }
  assert.match(await exec({ action: "update", id: "2.1" }), /^No change:/);
  assert.equal(changes(), 6);
  await assert.rejects(exec({ action: "update", id: "2.1", title: "saved", parentId: "2.1" }), /own parent/);
  assert.equal(store.read().tasks.at(-1)?.title, "saved", "title persists before the independent move");
  assert.equal(changes(), 7);
});

test("dependency changes preserve paths, no-op handling and mutation notifications", async (t) => {
  const { store, exec, changes } = setup(t, todoState("a", "b"));
  for (const [action, phrase, dependencies] of [
    ["addBlockedBy", "now", [2]], ["removeBlockedBy", "no longer", []],
  ] as const) {
    assert.equal(await exec({ action, id: "1", blockedBy: "2" }), `#1 is ${phrase} blocked by #2`);
    assert.deepEqual(store.read().tasks[0].blockedBy, dependencies);
    const before = changes();
    assert.match(await exec({ action, id: "1", blockedBy: "2" }), /^no change:/);
    assert.equal(changes(), before);
  }
  assert.equal(changes(), 2);
});

for (const parentId of [1, "1"]) test(`add with a ${typeof parentId} parent path returns created paths and fires changed`, async (t) => {
  const { exec, changes } = setup(t);
  const added = await exec({ action: "add", tasks: [{ title: "plan schema" }, { title: "write store", parentId }] }, "sess-A");
  assert.match(added, /added 2 task\(s\): #1 plan schema, #1\.1 write store/);
  assert.equal(changes(), 1);
  assert.match(await exec({ action: "list" }, "sess-A"), /Todos: 0\/2 done[\s\S]*○ plan schema[\s\S]*○ write store/);
});

test("validation errors throw with self-correcting messages", async (t) => {
  const { exec } = setup(t, todoState("parent", { title: "child", parentId: 1 }));
  await assert.rejects(exec({ action: "claim", id: 99 }), /not found/);
  await assert.rejects(exec({ action: "complete", id: "1.1" }), /evidence required/);
});

test("claim/release ownership with force path", async (t) => {
  const { exec, store } = setup(t, todoState("a"));
  await exec({ action: "claim", id: 1 }, "agent-A");
  assert.equal(store.read().tasks[0].status, "in_progress");
  await assert.rejects(exec({ action: "release", id: 1 }, "agent-B"), /force to override/);
  await assert.rejects(exec({ action: "claim", id: 1 }, "agent-B"), /retry with force/);
  assert.match(await exec({ action: "claim", id: 1, force: true }, "agent-B"), /claimed #1 for agent-B/);
  assert.equal(store.read().tasks[0].claim?.session, "agent-B");
  await exec({ action: "release", id: 1 }, "agent-B");
  assert.deepEqual([store.read().tasks[0].status, store.read().tasks[0].claim], ["pending", null]);
});

for (const status of ["pending", "complete", "skipped"] as const) test(`add to a ${status} list selects append or rotation`, async (t) => {
  const { exec, store } = setup(t, todoState(
    {
      title: "old", status: status === "skipped" ? "skipped" : "complete",
      evidence: "shipped", completedAt: 1, completedAtTurn: 1,
    },
    ...(status === "pending" ? [{ title: "another finished", status: "complete" as const }] : []),
  ));
  if (status === "complete") await assert.rejects(exec({ action: "skip", id: 1, reason: "too late" }), /illegal transition/);
  if (status === "pending") {
    assert.match(await exec({ action: "reopen", id: 1 }), /reopened/);
    assert.equal(store.read().tasks[0].status, "pending", "reopen maps the tool to a model transition");
    assert.equal(store.read().tasks[0].completedAtTurn, null, "reopened work must not remain hidden by its old completion turn");
  }
  const added = await exec({ action: "add", tasks: [{ title: "new work" }] });
  if (status !== "pending") {
    assert.match(added, /added 1 task\(s\): #1 new work \(new list: 1 finished task\(s\) cleared; ids restart at #1/);
    assert.deepEqual(store.read().tasks.map((task) => task.title), ["new work"]);
    await assert.rejects(exec({ action: "complete", id: "2", evidence: "shipped" }), /task #2 not found — current paths: #1/);
  } else {
    assert.match(added, /added 1 task\(s\): #3 new work/);
    assert.doesNotMatch(added, /new list/);
    assert.deepEqual(store.read().tasks.map((task) => task.title), ["old", "another finished", "new work"]);
  }
});
