// codex-todo store tests — tmpdir only, never a real HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
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

test("display snapshots parse once per file fingerprint; mutations keep fresh independent reads", async (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, TODO_STATE_FILE);
  let reads = 0;
  const store = openTodoStore(dir, { fs: {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === path) reads += 1;
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
  } });
  await store.mutate((state) => addTasks(state, [{ title: "one" }], 1));
  reads = 0;
  const snapshot = store.snapshot();
  for (let i = 0; i < 100; i += 1) assert.equal(store.snapshot(), snapshot);
  assert.equal(reads, 1, "one read/parse across unchanged frames");
  await store.mutate((state) => {
    assert.notEqual(state, snapshot, "mutators cannot change the shared display snapshot");
    return addTasks(state, [{ title: "two" }], 2);
  });
  assert.equal(reads, 2, "the mutation re-read the file under its lock");
  assert.equal(store.snapshot().tasks.length, 2);
  assert.equal(reads, 3, "successful writes invalidate the display cache");
  assert.equal(snapshot.tasks.length, 1);
  store.dispose();
  store.snapshot();
  assert.equal(reads, 4, "dispose releases the cached state");
});

test("display snapshots see same-size external edits, atomic replacement, deletion and recreation", async (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openTodoStore(dir);
  const path = join(dir, TODO_STATE_FILE);
  await store.mutate((state) => addTasks(state, [{ title: "aaa" }], 1));
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path, fixedTime, fixedTime);
  const first = store.snapshot();
  const original = fs.statSync(path, { bigint: true });
  const edit = readFileSync(path, "utf8").replace("aaa", "bbb");
  writeFileSync(path, edit);
  fs.utimesSync(path, fixedTime, fixedTime);
  assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, original.mtimeNs);
  assert.equal(fs.statSync(path).size, Number(original.size));
  assert.equal(store.snapshot().tasks[0].title, "bbb", "ctime detects rewrites with restored mtime");

  const replacement = `${path}.new`;
  writeFileSync(replacement, edit.replace("bbb", "ccc"));
  fs.utimesSync(replacement, fixedTime, fixedTime);
  fs.renameSync(replacement, path);
  assert.equal(store.snapshot().tasks[0].title, "ccc", "inode detects atomic replacement");
  fs.unlinkSync(path);
  const missing = store.snapshot();
  assert.equal(missing.tasks.length, 0);
  assert.equal(store.snapshot(), missing, "absence also has a stable snapshot");
  writeFileSync(path, JSON.stringify(first));
  assert.equal(store.snapshot().tasks[0].title, "aaa");
  writeFileSync(path, "{broken json");
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.status().backups.length, 1, "corruption still follows the archival recovery contract");
});

test("stat/read failures never become cached empty lists or corrupt-file backups", async (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, TODO_STATE_FILE);
  const writer = openTodoStore(dir);
  await writer.mutate((state) => addTasks(state, [{ title: "keep me" }], 1));
  let failure: "stat" | "read" | undefined;
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const store = openTodoStore(dir, { fs: {
    ...fs,
    statSync: ((...args: Parameters<typeof fs.statSync>) => {
      if (failure === "stat") throw denied;
      return fs.statSync(...args);
    }) as typeof fs.statSync,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      if (failure === "read") throw denied;
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
  } });
  failure = "read";
  assert.throws(() => store.snapshot(), denied);
  await assert.rejects(store.mutate((state) => addTasks(state, [{ title: "must not overwrite" }], 2)), denied);
  assert.ok(existsSync(path));
  assert.equal(readdirSync(dir).filter((name) => name.includes(".bak-")).length, 0);
  failure = undefined;
  assert.equal(store.snapshot().tasks[0].title, "keep me", "retry succeeds without a cached failure");
  failure = "stat";
  assert.throws(() => store.snapshot(), denied, "even a warm cache must not hide stat failures");
  failure = undefined;
  assert.equal(store.snapshot().tasks.length, 1);
});

test("a file changed during a snapshot read is not cached with the newer fingerprint", async (t) => {
  const dir = makeDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, TODO_STATE_FILE);
  const writer = openTodoStore(dir);
  await writer.mutate((state) => addTasks(state, [{ title: "before" }], 1));
  let replace = true;
  const store = openTodoStore(dir, { fs: {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const data = fs.readFileSync(...args);
      if (args[0] === path && replace) {
        replace = false;
        writeFileSync(path, String(data).replace("before", "after!"));
      }
      return data;
    }) as typeof fs.readFileSync,
  } });
  assert.equal(store.snapshot().tasks[0].title, "before");
  assert.equal(store.snapshot().tasks[0].title, "after!");
});
