// codex-todo store tests — tmpdir only, never a real HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTasks, claimTask, completeTask } from "../../src/todo/model.ts";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";

const makeDir = () => mkdtempSync(join(tmpdir(), "codex-todo-"));

test("store persists across open and survives re-open", async () => {
  const dir = makeDir();
  try {
    const s1 = openTodoStore(dir, { session: "a" });
    const added = await s1.mutate((st) => addTasks(st, [{ title: "one" }, { title: "two" }], 100));
    assert.ok(added.ok && added.value.length === 2);
    await s1.mutate((st) => claimTask(st, 1, "agent-A", 200));
    s1.dispose();

    const s2 = openTodoStore(dir, { session: "b" });
    const state = s2.read();
    assert.equal(state.tasks.length, 2);
    assert.equal(state.tasks[0].claim?.session, "agent-A");
    assert.equal(state.version, 1);
    assert.equal(typeof state.nextId, "number");
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt state is archived and store starts empty", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, TODO_STATE_FILE), "{not json", "utf8");
    const store = openTodoStore(dir);
    assert.equal(store.read().tasks.length, 0);
    const backups = readdirSync(dir).filter((f) => f.includes(".bak-"));
    assert.equal(backups.length, 1);
    assert.match(store.status().backups.join(","), /\.bak-/);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutations are atomic (tmp file never left behind)", async () => {
  const dir = makeDir();
  try {
    const store = openTodoStore(dir);
    const r = await store.mutate((st) => addTasks(st, [{ title: "x" }], 1));
    assert.ok(r.ok);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(join(dir, TODO_STATE_FILE)), true);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutations serialize through the in-process queue", async () => {
  const dir = makeDir();
  try {
    const store = openTodoStore(dir);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      store.mutate((st) => addTasks(st, [{ title: `task-${i}` }], i))));
    assert.ok(results.every((r) => r.ok));
    const state = store.read();
    assert.equal(state.tasks.length, 8);
    const ids = new Set(state.tasks.map((t: Task) => t.id));
    assert.equal(ids.size, 8);
    assert.equal(state.nextId, 9);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired foreign lock is archived and mutation proceeds", async () => {
  const dir = makeDir();
  try {
    // A lock from 60 minutes ago held by another "process".
    const stale = { pid: 424242, session: "dead-pi", at: Date.now() - 60 * 60 * 1000 };
    writeFileSync(join(dir, "tasks.lock"), JSON.stringify(stale), "utf8");
    const store = openTodoStore(dir);
    const r = await store.mutate((st) => addTasks(st, [{ title: "after crash" }], 1));
    assert.ok(r.ok, r.ok ? "" : (r as { error: string }).error);
    assert.equal(existsSync(join(dir, "tasks.lock")), false);
    const archived = readdirSync(dir).filter((f) => f.startsWith("stale-lock-"));
    assert.equal(archived.length, 1);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GC removes old completed leaves and reparents survivors", async () => {
  const dir = makeDir();
  try {
    const old = 10 * 24 * 60 * 60 * 1000; // 10 days ago
    writeFileSync(join(dir, TODO_STATE_FILE), JSON.stringify({
      version: 1,
      nextId: 4,
      tasks: [
        { id: 1, title: "parent", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: old, updatedAt: old, completedAt: old, completedAtTurn: 1 },
        { id: 2, title: "child stays open", parentId: 1, status: "pending", blockedBy: [], claim: null, evidence: null, skipReason: null, createdAt: old, updatedAt: old, completedAt: null, completedAtTurn: null },
        { id: 3, title: "recent done", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now(), completedAtTurn: 2 },
      ],
    }), "utf8");
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ gcDays: 7 }), "utf8");
    const store = openTodoStore(dir);
    const removed = store.collect();
    assert.equal(removed, 0); // #1 still has an open descendant → kept
    const state = store.read();
    assert.equal(state.tasks.length, 3);
    const done = completeTask(state, 2, "finally", Date.now(), 3);
    assert.ok(done.ok);
    const r2 = await store.mutate(() => done);
    assert.ok(r2.ok);
    const after = store.read();
    assert.equal(after.tasks.length, 2); // #1 GC'd, #2 reparented to root
    const child = after.tasks.find((t) => t.id === 2)!;
    assert.equal(child.parentId, null);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state file round-trips exact content", async () => {
  const dir = makeDir();
  try {
    const store = openTodoStore(dir);
    await store.mutate((st) => addTasks(st, [{ title: "persist me" }], 42));
    const onDisk = JSON.parse(readFileSync(join(dir, TODO_STATE_FILE), "utf8"));
    assert.equal(onDisk.tasks[0].title, "persist me");
    assert.equal(onDisk.version, 1);
    assert.ok(statSync(join(dir, TODO_STATE_FILE)).size > 0);
    store.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
