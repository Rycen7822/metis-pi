// codex-todo model tests — pure functions, no fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTasks, addBlockedBy, claimTask, completeTask,
  completionBlock, createState, pathOf, taskPaths, taskRows,
  MAX_DEPTH, MAX_TASKS, moveTask,
  sanitizeText, skipTask } from "../../src/todo/model.ts";

import { todoState } from "../helpers/todo.mts";

const T0 = 1_000;
test("paths follow three nested levels when parents were created after children", () => {
  const state = todoState({ title: "child", parentId: 2 }, { title: "parent", parentId: 3 }, "root", "other root");
  assert.deepEqual([...taskPaths(state)], [[3, "#1"], [2, "#1.1"], [1, "#1.1.1"], [4, "#2"]]);
});

test("orphan rows retain fallback paths and parents retain their own status", () => {
  const state = todoState("root", { title: "child", parentId: 1, status: "complete" });
  assert.deepEqual(taskRows(state).map((row) => row.task.status), ["pending", "complete"]);
  const orphan = { ...state, tasks: state.tasks.filter((task) => task.id !== 1) };
  assert.equal(pathOf(orphan, 2), "#?1");
  assert.deepEqual(taskRows(orphan).map((row) => [row.task.id, row.depth, row.hasChildren]), [[2, 1, false]]);
});

const seed = () => ({ state: todoState("root A", "root B",
  { title: "A.1", parentId: 1 }, { title: "A.2", parentId: 1 }) });

test("sanitizeText strips ANSI/OSC/bidi and flattens whitespace", () => {
  assert.equal(sanitizeText("  hi\u001b[31mRED\u001b[0m\u202edone\nnext\t tab  "), "hiREDdone next tab");
  assert.equal(sanitizeText("\u001b]8;;https://x\u0007link\u001b]8;;\u001b\\"), "link");
  assert.equal(sanitizeText("   "), "");
});

test("add validates caps, duplicates, parents and depth", () => {
  const { state } = seed();
  const dupe = addTasks(state, [{ title: "root a" }], T0);
  assert.ok(!dupe.ok && /duplicate title/.test(dupe.error));
  const badParent = addTasks(state, [{ title: "x", parentId: 99 }], T0);
  assert.ok(!badParent.ok && /does not exist/.test(badParent.error));
  const batchDupe = addTasks(state, [{ title: "n1" }, { title: "N1" }], T0);
  assert.ok(!batchDupe.ok && /duplicate title/.test(batchDupe.error));
  // Depth cap: #3 sits at depth 2; chain children until the limit, then fail.
  let s = state;
  let last = 3;
  for (let i = 0; i < MAX_DEPTH - 2; i += 1) {
    const r = addTasks(s, [{ title: `deep${i}`, parentId: last }], T0);
    assert.ok(r.ok);
    s = r.state;
    last = r.value[0].id;
  }
  const tooDeep = addTasks(s, [{ title: "deeper", parentId: last }], T0);
  assert.ok(!tooDeep.ok && /MAX_DEPTH/.test(tooDeep.error));
  const over = addTasks(createState(), Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ title: `t${i}` })), T0);
  assert.ok(!over.ok && /MAX_TASKS/.test(over.error));
});

test("complete is gated on subtree and evidence (default block)", () => {
  const { state } = seed();
  assert.match(completionBlock(state, 1, "did it")!, /unfinished subtasks/);
  assert.match(completionBlock(state, 3, "  ")!, /evidence required/);
  const child = completeTask(state, 3, "A.1 evidence: file exists", T0, 7);
  assert.ok(child.ok);
  const child2 = completeTask(child.state, 4, "A.2 evidence", T0, 7);
  assert.ok(child2.ok);
  const parent = completeTask(child2.state, 1, "A evidence", T0, 7);
  assert.ok(parent.ok);
  assert.equal(parent.value.completedAtTurn, 7);
  assert.equal(parent.value.claim, null);
});

test("skip cascades to unfinished descendants with reasons", () => {
  const { state } = seed();
  const started = claimTask(state, 3, "agent-A", T0);
  assert.ok(started.ok);
  const r = skipTask(started.state, 1, "no longer needed", T0);
  assert.ok(r.ok);
  assert.deepEqual(r.state.tasks.map((task) => [task.id, task.status]), [
    [1, "skipped"], [2, "pending"], [3, "skipped"], [4, "skipped"],
  ], "skip cascades through children and leaves the sibling root untouched");
  const t1 = r.state.tasks.find((t) => t.id === 1)!;
  assert.equal(t1.skipReason, "no longer needed");
  const t3 = r.state.tasks.find((t) => t.id === 3)!;
  assert.match(t3.skipReason!, /parent #1 skipped/);
});

test("blockedBy rejects self, dangling and cyclic edges but permits a child waiting on its parent", () => {
  const { state } = seed();
  const self = addBlockedBy(state, 1, 1, T0);
  assert.ok(!self.ok && /itself/.test(self.error));
  const dangling = addBlockedBy(state, 1, 42, T0);
  assert.ok(!dangling.ok && /does not exist/.test(dangling.error));
  const ok = addBlockedBy(state, 1, 2, T0);
  assert.ok(ok.ok && ok.value.blockedBy.join() === "2");
  // Cycle in waits-for edges: 1 waits on 2, so 2 waiting on 1 closes the loop.
  const cycle = addBlockedBy(ok.state, 2, 1, T0);
  assert.ok(!cycle.ok && /cycle/.test(cycle.error));
  // A CHILD waiting on its parent is legal signal, not a deadlock cycle.
  const childWaitsOnParent = addBlockedBy(state, 3, 1, T0);
  assert.ok(childWaitsOnParent.ok, childWaitsOnParent.ok ? "" : childWaitsOnParent.error);
});

test("move rejects cycles and re-parents", () => {
  const { state } = seed();
  const cyc = moveTask(state, 1, 3, T0);
  assert.ok(!cyc.ok && /cycle/.test(cyc.error));
  const ok = moveTask(state, 2, 1, T0);
  assert.ok(ok.ok && ok.value.parentId === 1);
});
