// codex-todo model tests — pure functions, no fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTasks, addBlockedBy, canTransition, claimTask, completeTask,
  completionBlock, createState, pathOf, taskPaths, taskRows,
  isListFinished, MAX_DEPTH, MAX_TASKS, moveTask,
  releaseTask, removeBlockedBy, sanitizeText, skipTask, startNewList, transitionTask,
  VALID_TRANSITIONS, type TodoState } from "../../src/todo/model.ts";

const T0 = 1_000;
test("task rows preserve path order and depth across all creation orders", () => {
  const added = addTasks(createState(), [
    { title: "root" }, { title: "child", parentId: 1 }, { title: "grandchild", parentId: 2 },
    { title: "other root" }, { title: "other child", parentId: 4 },
  ], T0);
  assert.ok(added.ok);
  const permutations = <T,>(items: T[]): T[][] => items.length === 0 ? [[]]
    : items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]));
  const depths = new Map([[1, 1], [2, 2], [3, 3], [4, 1], [5, 2]]);
  for (const tasks of permutations(added.state.tasks)) {
    const state: TodoState = { ...added.state, tasks };
    const before = structuredClone(state);
    const rows = taskRows(state);
    assert.deepEqual(rows.map((row) => row.task.id), [...taskPaths(state).keys()]);
    for (const row of rows) {
      assert.equal(row.depth, depths.get(row.task.id));
      assert.equal(row.hasChildren, row.task.id === 1 || row.task.id === 2 || row.task.id === 4);
      assert.equal(row.task, tasks.find((task) => task.id === row.task.id));
    }
    assert.deepEqual(state, before, "projection cannot mutate the persisted model");
  }
});

test("orphan rows retain fallback paths and parents retain their own status", () => {
  const added = addTasks(createState(), [{ title: "root" }, { title: "child", parentId: 1 }], T0);
  assert.ok(added.ok);
  const done = completeTask(added.state, 2, "done", T0, 1);
  assert.ok(done.ok);
  assert.deepEqual(taskRows(done.state).map((row) => row.task.status), ["pending", "complete"]);
  const orphan = { ...done.state, tasks: done.state.tasks.filter((task) => task.id !== 1) };
  assert.equal(pathOf(orphan, 2), "#?1");
  assert.deepEqual(taskRows(orphan).map((row) => [row.task.id, row.depth, row.hasChildren]), [[2, 1, false]]);
});

const seed = (): { state: TodoState } => {
  const r = addTasks(createState(), [{ title: "root A" }, { title: "root B" }], T0);
  assert.ok(r.ok);
  const r2 = addTasks(r.state, [{ title: "A.1", parentId: 1 }, { title: "A.2", parentId: 1 }], T0);
  assert.ok(r2.ok);
  return { state: r2.state };
};

test("sanitizeText strips ANSI/OSC/bidi and flattens whitespace", () => {
  assert.equal(sanitizeText("  hi\u001b[31mRED\u001b[0m\u202edone\nnext\t tab  "), "hiREDdone next tab");
  assert.equal(sanitizeText("\u001b]8;;https://x\u0007link\u001b]8;;\u001b\\"), "link");
  assert.equal(sanitizeText("   "), "");
});

test("transition table is explicit and one-way for complete", () => {
  assert.deepEqual(VALID_TRANSITIONS.complete, ["pending"]);
  assert.equal(canTransition("pending", "in_progress"), true);
  assert.equal(canTransition("complete", "in_progress"), false);
  const { state } = seed();
  const r = transitionTask(state, 1, "in_progress", T0);
  assert.ok(r.ok);
  const back = transitionTask(r.state, 1, "in_progress", T0);
  assert.ok(!back.ok && /no change/.test(back.error));
  const started3 = transitionTask(r.state, 3, "in_progress", T0);
  assert.ok(started3.ok);
  const done3 = transitionTask(started3.state, 3, "complete", T0);
  assert.ok(done3.ok);
  const reopen = transitionTask(done3.state, 3, "pending", T0);
  assert.ok(reopen.ok && reopen.value.completedAt === null);
  const illegal = transitionTask(done3.state, 3, "in_progress", T0) as { ok: false; error: string };
  assert.ok(!illegal.ok && /illegal transition #3: complete → in_progress/.test(illegal.error));
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
  const statuses = new Map(r.state.tasks.map((t) => [t.id, t.status]));
  assert.equal(statuses.get(1), "skipped");
  assert.equal(statuses.get(3), "skipped");
  assert.equal(statuses.get(4), "skipped");
  assert.equal(statuses.get(2), "pending"); // sibling root untouched
  const t1 = r.state.tasks.find((t) => t.id === 1)!;
  assert.equal(t1.skipReason, "no longer needed");
  const t3 = r.state.tasks.find((t) => t.id === 3)!;
  assert.match(t3.skipReason!, /parent #1 skipped/);
});

test("claims: owner-only release, force takeover, pending→in_progress", () => {
  const { state } = seed();
  const claimed = claimTask(state, 2, "agent-A", T0);
  assert.ok(claimed.ok && claimed.value.status === "in_progress" && claimed.value.claim?.session === "agent-A");
  const steal = claimTask(claimed.state, 2, "agent-B", T0);
  assert.ok(!steal.ok && /claimed by agent-A/.test(steal.error));
  const forced = claimTask(claimed.state, 2, "agent-B", T0, true);
  assert.ok(forced.ok && forced.value.claim?.session === "agent-B");
  const foreignRelease = releaseTask(forced.state, 2, "agent-A", T0);
  assert.ok(!foreignRelease.ok && /force to override/.test(foreignRelease.error));
  const released = releaseTask(forced.state, 2, "agent-B", T0);
  assert.ok(released.ok && released.value.status === "pending" && released.value.claim === null);
});

test("blockedBy: self/dangling/cycle/no-change all rejected incrementally", () => {
  const { state } = seed();
  const self = addBlockedBy(state, 1, 1, T0);
  assert.ok(!self.ok && /itself/.test(self.error));
  const dangling = addBlockedBy(state, 1, 42, T0);
  assert.ok(!dangling.ok && /does not exist/.test(dangling.error));
  const ok = addBlockedBy(state, 1, 2, T0);
  assert.ok(ok.ok && ok.value.blockedBy.join() === "2");
  const again = addBlockedBy(ok.state, 1, 2, T0);
  assert.ok(!again.ok && /no change/.test(again.error));
  const removed = removeBlockedBy(ok.state, 1, 2, T0);
  assert.ok(removed.ok && removed.value.blockedBy.length === 0);
  const notBlocked = removeBlockedBy(removed.state, 1, 2, T0);
  assert.ok(!notBlocked.ok && /no change/.test(notBlocked.error));
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

test("taskPaths numbers subtasks hierarchically (1, 1.1, 1.1.1, 2, 2.1)", () => {
  const r1 = addTasks(createState(), [{ title: "root" }], T0);
  assert.ok(r1.ok);
  const r2 = addTasks(r1.state, [{ title: "child a", parentId: 1 }, { title: "second root" }], T0);
  assert.ok(r2.ok);
  const r3 = addTasks(r2.state, [{ title: "grandchild", parentId: 2 }, { title: "second child", parentId: 3 }], T0);
  assert.ok(r3.ok);
  const state = r3.state;
  assert.deepEqual([...taskPaths(state).values()], ["#1", "#1.1", "#1.1.1", "#2", "#2.1"]);
  // pathOf takes the internal id — the language the model layer speaks.
  assert.equal(pathOf(state, 1), "#1");
  assert.equal(pathOf(state, 2), "#1.1");
  assert.equal(pathOf(state, 3), "#2");
  assert.equal(pathOf(state, 4), "#1.1.1");
  assert.equal(pathOf(state, 5), "#2.1");
});

test("a finished list is history: isListFinished and startNewList", () => {
  // transitionTask/skipTask return the patched task (and skipTask also returns a
  // cascaded state); the store is what folds them back into a TodoState.
  const close = (state: TodoState, id: number): TodoState => {
    const started = transitionTask(state, id, "in_progress", T0);
    assert.ok(started.ok);
    const mid = { ...state, tasks: state.tasks.map((t) => (t.id === id ? started.value : t)) };
    const done = transitionTask(mid, id, "complete", T0);
    assert.ok(done.ok);
    return { ...mid, tasks: mid.tasks.map((t) => (t.id === id ? done.value : t)) };
  };
  const skip = (state: TodoState, id: number): TodoState => {
    const r = skipTask(state, id, "not needed", T0);
    assert.ok(r.ok);
    return r.state;
  };

  assert.equal(isListFinished(createState()), false, "an empty list is not a finished one");
  const { state } = seed();
  assert.equal(isListFinished(state), false, "open tasks keep the list live");

  // Close the tree child-first (A.1, A.2, A) and leave B open.
  let s = state;
  for (const id of [3, 4, 1]) s = close(s, id);
  assert.equal(isListFinished(s), false, "one live task still holds the list open");
  s = skip(s, 2);
  assert.equal(isListFinished(s), true, "every task complete or skipped");

  // A new list drops the tasks and restarts the ids at #1, so the panel reads
  // like a fresh plan. Ids are therefore unique only WITHIN a list: `add`
  // reports the restart loudly because of exactly that.
  const fresh = startNewList(s);
  assert.deepEqual(fresh.tasks, []);
  assert.equal(fresh.version, s.version);
  assert.equal(fresh.nextId, 1, "a new list starts numbering at #1");
  const added = addTasks(fresh, [{ title: "next batch" }], T0);
  assert.ok(added.ok);
  assert.equal(added.value[0].id, 1, "the first task of a new list is #1");
  assert.equal(added.state.nextId, 2);
  assert.equal(s.tasks.length, 4, "the previous list is not mutated");
});
