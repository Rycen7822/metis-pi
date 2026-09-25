// Persistence and snapshot caching against isolated real files, never HOME.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { addTasks, claimTask, completeTask } from "../../src/todo/model.ts";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";

function fixture(t: TestContext) {
  const dir = temporaryDirectory(t);
  const open = (options?: Parameters<typeof openTodoStore>[1]) => {
    const store = openTodoStore(dir, options);
    t.after(() => store.dispose());
    return store;
  };
  return { dir, path: join(dir, TODO_STATE_FILE), open };
}

test("store persists the exact state and survives re-open", async (t) => {
  const { path, open } = fixture(t);
  const first = open({ session: "a" });
  const added = await first.mutate((state) => addTasks(state, [{ title: "one" }, { title: "two" }], 100));
  assert.ok(added.ok && added.value.length === 2);
  await first.mutate((state) => claimTask(state, 1, "agent-A", 200));
  first.dispose();
  const state = open({ session: "b" }).read();
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].claim?.session, "agent-A");
  assert.equal(state.version, 1);
  assert.equal(typeof state.nextId, "number");
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), state, "disk shape matches the reopened state");
});

test("corrupt state is archived and store starts empty", (t) => {
  const { dir, path, open } = fixture(t);
  fs.writeFileSync(path, "{not json");
  const store = open();
  assert.equal(store.read().tasks.length, 0);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".bak-")).length, 1);
  assert.match(store.status().backups.join(","), /\.bak-/);
});

test("mutations are atomic and serialize through the in-process queue", async (t) => {
  for (const count of [1, 8]) {
    const { dir, path, open } = fixture(t);
    const store = open();
    const results = await Promise.all(Array.from({ length: count }, (_, i) =>
      store.mutate((state) => addTasks(state, [{ title: `task-${i}` }], i))));
    assert.ok(results.every((result) => result.ok));
    const state = store.read();
    assert.equal(state.tasks.length, count);
    assert.equal(new Set(state.tasks.map((task) => task.id)).size, count);
    assert.equal(state.nextId, count + 1);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
    assert.equal(fs.existsSync(path), true);
  }
});

test("expired foreign lock is archived and mutation proceeds", async (t) => {
  const { dir, open } = fixture(t);
  const stale = { pid: 424242, session: "dead-pi", at: Date.now() - 60 * 60 * 1000 };
  fs.writeFileSync(join(dir, "tasks.lock"), JSON.stringify(stale));
  const result = await open().mutate((state) => addTasks(state, [{ title: "after crash" }], 1));
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(fs.existsSync(join(dir, "tasks.lock")), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.startsWith("stale-lock-")).length, 1);
});

test("GC removes old completed leaves and reparents survivors", async (t) => {
  const { dir, path, open } = fixture(t);
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const recent = Date.now();
  fs.writeFileSync(path, JSON.stringify({
    version: 1, nextId: 4,
    tasks: [
      { id: 1, title: "parent", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: old, updatedAt: old, completedAt: old, completedAtTurn: 1 },
      { id: 2, title: "child stays open", parentId: 1, status: "pending", blockedBy: [], claim: null, evidence: null, skipReason: null, createdAt: old, updatedAt: old, completedAt: null, completedAtTurn: null },
      { id: 3, title: "recent done", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: recent, updatedAt: recent, completedAt: recent, completedAtTurn: 2 },
    ],
  }));
  fs.writeFileSync(join(dir, "settings.json"), JSON.stringify({ gcDays: 7 }));
  const store = open();
  assert.equal(store.collect(), 0, "the completed parent still has an open descendant");
  assert.equal(store.read().tasks.length, 3);
  const done = await store.mutate((state) => completeTask(state, 2, "finally", Date.now(), 3));
  assert.ok(done.ok);
  assert.equal(store.read().tasks.length, 2);
  assert.equal(store.read().tasks.find((task) => task.id === 2)?.parentId, null);
});

test("display snapshots parse once per fingerprint; mutations keep fresh independent reads", async (t) => {
  const { path, open } = fixture(t);
  const io = { ...fs };
  const read = t.mock.method(io, "readFileSync");
  const reads = () => read.mock.calls.filter((call) => call.arguments[0] === path).length;
  const store = open({ fs: io });
  await store.mutate((state) => addTasks(state, [{ title: "one" }], 1));
  read.mock.resetCalls();
  const snapshot = store.snapshot();
  for (let i = 0; i < 100; i++) assert.equal(store.snapshot(), snapshot);
  assert.equal(reads(), 1);
  await store.mutate((state) => {
    assert.notEqual(state, snapshot, "mutators cannot change the shared display snapshot");
    return addTasks(state, [{ title: "two" }], 2);
  });
  assert.equal(reads(), 2, "mutation re-reads under its lock");
  assert.equal(store.snapshot().tasks.length, 2);
  assert.equal(reads(), 3, "successful writes invalidate the cache");
  assert.equal(snapshot.tasks.length, 1);
  store.dispose();
  store.snapshot();
  assert.equal(reads(), 4, "dispose releases cached state");
});

test("snapshots see same-size edits, atomic replacement, deletion, recreation and corruption", async (t) => {
  const { path, open } = fixture(t);
  const store = open();
  await store.mutate((state) => addTasks(state, [{ title: "aaa" }], 1));
  const fixedTime = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path, fixedTime, fixedTime);
  const first = store.snapshot();
  const original = fs.statSync(path, { bigint: true });
  const edit = fs.readFileSync(path, "utf8").replace("aaa", "bbb");
  fs.writeFileSync(path, edit);
  fs.utimesSync(path, fixedTime, fixedTime);
  assert.equal(fs.statSync(path, { bigint: true }).mtimeNs, original.mtimeNs);
  assert.equal(fs.statSync(path).size, Number(original.size));
  assert.equal(store.snapshot().tasks[0].title, "bbb", "ctime detects edits with restored mtime");
  fs.writeFileSync(`${path}.new`, edit.replace("bbb", "ccc"));
  fs.utimesSync(`${path}.new`, fixedTime, fixedTime);
  fs.renameSync(`${path}.new`, path);
  assert.equal(store.snapshot().tasks[0].title, "ccc", "inode detects replacement");
  fs.unlinkSync(path);
  const missing = store.snapshot();
  assert.equal(missing.tasks.length, 0);
  assert.equal(store.snapshot(), missing, "absence also has a stable snapshot");
  fs.writeFileSync(path, JSON.stringify(first));
  assert.equal(store.snapshot().tasks[0].title, "aaa");
  fs.writeFileSync(path, "{broken json");
  assert.equal(store.snapshot().tasks.length, 0);
  assert.equal(store.status().backups.length, 1);
});

test("stat/read failures never become cached empty lists or corrupt-file backups", async (t) => {
  const { dir, path, open } = fixture(t);
  await open().mutate((state) => addTasks(state, [{ title: "keep me" }], 1));
  const io = { ...fs };
  const store = open({ fs: io });
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const read = t.mock.method(io, "readFileSync", () => { throw denied; });
  assert.throws(() => store.snapshot(), denied);
  await assert.rejects(store.mutate((state) => addTasks(state, [{ title: "must not overwrite" }], 2)), denied);
  assert.ok(fs.existsSync(path));
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".bak-")).length, 0);
  read.mock.restore();
  assert.equal(store.snapshot().tasks[0].title, "keep me", "failure is not cached");
  const stat = t.mock.method(io, "statSync", () => { throw denied; });
  assert.throws(() => store.snapshot(), denied, "a warm cache cannot hide stat failure");
  stat.mock.restore();
  assert.equal(store.snapshot().tasks.length, 1);
});

test("a file changed during a snapshot read is not cached with the newer fingerprint", async (t) => {
  const { path, open } = fixture(t);
  await open().mutate((state) => addTasks(state, [{ title: "before" }], 1));
  const io = { ...fs };
  const read = t.mock.method(io, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const data = fs.readFileSync(...args);
    if (args[0] === path) {
      read.mock.restore();
      fs.writeFileSync(path, String(data).replace("before", "after!"));
    }
    return data;
  });
  const store = open({ fs: io });
  assert.equal(store.snapshot().tasks[0].title, "before");
  assert.equal(store.snapshot().tasks[0].title, "after!");
});
