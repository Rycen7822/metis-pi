// codex-todo model tests — pure functions, no fs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTasks, addBlockedBy, buildTree, canTransition, claimTask, completeTask,
  completionBlock, createState, diffTask, flattenTree, formatTaskId,
  isBlocked, MAX_DEPTH, MAX_TASKS, moveTask, nextTaskId, progressOf,
  releaseTask, removeBlockedBy, sanitizeText, skipTask, transitionTask,
  updateTitle, VALID_TRANSITIONS, type TodoState,
} from "../src/todo/model.ts";

const T0 = 1_000;
const seed = (): { state: TodoState } => {
  const r = addTasks(createState(T0), [{ title: "root A" }, { title: "root B" }], T0);
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
  const over = addTasks(createState(T0), Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ title: `t${i}` })), T0);
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

test("isBlocked tracks unfinished blockers", () => {
  const { state } = seed();
  const withDep = addBlockedBy(state, 2, 1, T0);
  assert.ok(withDep.ok);
  assert.equal(isBlocked(withDep.state, 2), true);
  // Finishing the blocker clears the flag (children of #1 first — gate).
  const c3 = completeTask(withDep.state, 3, "ev3", T0, 1);
  assert.ok(c3.ok);
  const c4 = completeTask(c3.state, 4, "ev4", T0, 1);
  assert.ok(c4.ok);
  const done = completeTask(c4.state, 1, "ev1", T0, 1);
  assert.ok(done.ok);
  assert.equal(isBlocked(done.state, 2), false);
});

test("derived parent status and leaf-only progress", () => {
  const { state } = seed(); // #1 pending with children 3,4; #2 pending leaf
  const flat = flattenTree(buildTree(state));
  assert.equal(flat.length, 4);
  assert.equal(flat.find((n) => n.task.id === 1)!.depth, 1);
  assert.equal(flat.find((n) => n.task.id === 3)!.depth, 2);
  assert.equal(progressOf(state).total, 3); // leaves: 3,4,2 — parents not work units
  const child = transitionTask(state, 3, "in_progress", T0);
  assert.ok(child.ok);
  const roots = buildTree(child.state);
  assert.equal(roots[0].displayStatus, "in_progress"); // derived, not stored
  const stored = child.state.tasks.find((t) => t.id === 1)!;
  assert.equal(stored.status, "pending"); // source of truth untouched
});

test("nextTaskId suggests first unclaimed unblocked pending leaf", () => {
  const { state } = seed();
  assert.equal(nextTaskId(state), 3);
  const dep = addBlockedBy(state, 3, 2, T0);
  assert.ok(dep.ok);
  assert.equal(nextTaskId(dep.state), 4); // 3 blocked by 2
  const claimed = claimTask(dep.state, 4, "agent-A", T0);
  assert.ok(claimed.ok);
  assert.equal(nextTaskId(claimed.state), 2); // 2 is the only live unclaimed leaf
});

test("move rejects cycles and re-parents", () => {
  const { state } = seed();
  const cyc = moveTask(state, 1, 3, T0);
  assert.ok(!cyc.ok && /cycle/.test(cyc.error));
  const ok = moveTask(state, 2, 1, T0);
  assert.ok(ok.ok && ok.value.parentId === 1);
});

test("updateTitle validates duplicates and sanitizes", () => {
  const { state } = seed();
  const dupe = updateTitle(state, 1, "root b", T0);
  assert.ok(!dupe.ok && /duplicate title/.test(dupe.error));
  const ok = updateTitle(state, 1, "  root A² \n", T0);
  assert.ok(ok.ok && ok.value.title === "root A²");
});

test("diffTask powers the no-change tool responses", () => {
  const { state } = seed();
  const r = transitionTask(state, 2, "in_progress", T0);
  assert.ok(r.ok);
  assert.deepEqual(diffTask(state.tasks.find((t) => t.id === 2)!, r.value), ["status"]);
  assert.deepEqual(diffTask(r.value, r.value), []);
});

test("formatTaskId renders #N", () => {
  assert.equal(formatTaskId(12), "#12");
});
