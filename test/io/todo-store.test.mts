// Persistence and snapshot caching against isolated real files, never HOME.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { todoState } from "../helpers/todo.mts";
import { addTasks, claimTask, completeTask } from "../../src/todo/model.ts";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";
import { createTodoToolHandlers } from "../../src/todo/tools.ts";

function fixture(t: TestContext, title?: string) {
  const dir = temporaryDirectory(t);
  const path = join(dir, TODO_STATE_FILE);
  if (title !== undefined) fs.writeFileSync(path, JSON.stringify(todoState(title)));
  const open = (options?: Parameters<typeof openTodoStore>[1]) => {
    const store = openTodoStore(dir, options);
    t.after(() => store.dispose());
    return store;
  };
  return { dir, path, open };
}

test("store serializes writes, survives re-open and archives corruption in one directory", async (t) => {
  const { dir, path, open } = fixture(t);
  const first = open({ session: "a" });
  const added = await first.mutate((state) => addTasks(state, [{ title: "one" }, { title: "two" }], 100));
  assert.ok(added.ok && added.value.length === 2);
  await first.mutate((state) => claimTask(state, 1, "agent-A", 200));
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) =>
    first.mutate((state) => addTasks(state, [{ title: `concurrent-${i}` }], i))));
  assert.ok(results.every((result) => result.ok));
  const written = first.read();
  assert.equal(written.tasks.length, 11);
  assert.equal(new Set(written.tasks.map((task) => task.id)).size, 11);
  assert.equal(written.nextId, 12);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  assert.equal(fs.existsSync(path), true);
  first.dispose();
  const state = open({ session: "b" }).read();
  assert.equal(state.tasks.length, 11);
  assert.equal(state.tasks[0].claim?.session, "agent-A");
  assert.equal(state.version, 1);
  assert.equal(state.nextId, 12);
  assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), state, "disk shape matches the reopened state");

  fs.writeFileSync(path, "{not json");
  const recovered = open();
  assert.equal(recovered.read().tasks.length, 0);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes(".bak-")).length, 1);
  assert.match(recovered.status().backups.join(","), /\.bak-/);
});

test("tool completion checks evidence paths and persists evidence and turn", async (t) => {
  const { dir, path, open } = fixture(t);
  fs.writeFileSync(path, JSON.stringify(todoState("a")));
  const store = open();
  const execute = createTodoToolHandlers({ store, turn: () => 3, changed() {} }, () => dir);
  const complete = (evidenceFiles: string[]) => execute({ action: "complete", id: 1, evidence: "proof written", evidenceFiles }, "s");
  fs.writeFileSync(join(dir, "proof.txt"), "ok", "utf8");
  await assert.rejects(complete(["missing.txt"]), /evidence files do not exist — missing\.txt/);
  assert.match((await complete(["proof.txt"])).content[0].text, /completed #1/);
  const saved = open().read().tasks[0];
  assert.equal(saved.evidence, "proof written");
  assert.equal(saved.completedAtTurn, 3);
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
  fs.writeFileSync(path, JSON.stringify(todoState(
    { title: "parent", status: "complete", evidence: "e", createdAt: old, updatedAt: old, completedAt: old, completedAtTurn: 1 },
    { title: "child stays open", parentId: 1, createdAt: old, updatedAt: old },
    { title: "recent done", status: "complete", evidence: "e", createdAt: recent, updatedAt: recent, completedAt: recent, completedAtTurn: 2 },
  )));
  fs.writeFileSync(join(dir, "settings.json"), JSON.stringify({ gcDays: 7 }));
  const store = open();
  assert.equal(store.collect(), 0, "the completed parent still has an open descendant");
  assert.equal(store.read().tasks.length, 3);
  const done = await store.mutate((state) => completeTask(state, 2, "finally", Date.now(), 3));
  assert.ok(done.ok);
  assert.equal(store.read().tasks.length, 2);
  assert.equal(store.read().tasks.find((task) => task.id === 2)?.parentId, null);
});

test("snapshot cache isolates mutations, releases on dispose and never caches a read under a later fingerprint", async (t) => {
  const { path, open } = fixture(t, "one");
  const io = { ...fs };
  const read = t.mock.method(io, "readFileSync");
  const reads = () => read.mock.calls.filter((call) => call.arguments[0] === path).length;
  const store = open({ fs: io });
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
  read.mock.mockImplementationOnce(((...args: Parameters<typeof fs.readFileSync>) => {
    const data = fs.readFileSync(...args);
    fs.writeFileSync(path, String(data).replace('"one"', '"changed"'));
    return data;
  }) as typeof fs.readFileSync);
  assert.equal(store.snapshot().tasks[0].title, "one", "the racing read returns its original bytes");
  assert.equal(reads(), 4, "dispose releases cached state");
  assert.equal(store.snapshot().tasks[0].title, "changed", "newer file bytes must be read again");
  assert.equal(reads(), 5, "the old bytes were not cached with the newer fingerprint");
});

test("snapshots see same-size edits, atomic replacement, deletion, recreation and corruption", (t) => {
  const { path, open } = fixture(t, "aaa");
  const store = open();
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
  const { dir, path, open } = fixture(t, "keep me");
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
