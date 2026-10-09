import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isDaemonIdle, RuntimeError, SubagentClient, runtimePackage } from "../../src/subagents/client.ts";
import { SubagentSession } from "../../src/subagents/session.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function status(runtime, state) {
  try { return JSON.parse(execFileSync("python3", [join(runtime.root, "bin/subagent-pi"), "--home", state, "daemon", "status"], { encoding: "utf8" })); }
  catch (error) { const result = JSON.parse(String(error.stdout)); assert.equal(result.error.code, "daemon_unavailable"); return undefined; }
}
async function fixture(t) {
  mkdirSync(join(root, ".work"), { recursive: true });
  const dir = mkdtempSync(join(root, ".work/metis-subagent-parking-")), state = join(dir, "subagent-pi"), runtime = runtimePackage();
  mkdirSync(state);
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [join(root, "test/subagents/pi_mock_provider.ts")] }));
  writeFileSync(join(dir, "metis-pi.toml"), '[subagents.profiles.reader.env]\nPI_OFFLINE="1"\nPI_MOCK_STREAM_MS="30"\n');
  const ctx = { cwd: dir, model: { provider: "pi-mock-offline", id: "mock" }, sessionManager: SessionManager.create(dir, dir), isProjectTrusted: () => true };
  const client = new SubagentClient(runtime, ctx, dir, undefined, () => {}), clients = [client];
  t.after(async () => {
    try {
      for (const client of clients) await client.close();
      if (status(runtime, state)) execFileSync("python3", [join(runtime.root, "bin/subagent-pi"), "--home", state, "daemon", "stop", "--force"], { timeout: 20000 });
      if (clients.some(client => client.scope)) execFileSync("python3", ["-c", "import fcntl,sys; f=open(sys.argv[1],'rb'); fcntl.flock(f,fcntl.LOCK_EX)", join(state, "daemon.lock")], { timeout: 20000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { dir, state, runtime, client, clients, ctx };
}

test("native SDK follow-up wakes an idle daemon through the same bridge and keeps the durable child session", { timeout: 40000 }, async t => {
  const f = await fixture(t), { client } = f;
  const first = await client.call("pi_spawn_agent", { task: "parking-original-sentinel", access: "read", request_id: "parking-original" });
  const waited = await client.call("pi_wait_agent", { run_ids: [first.run_id], timeout_seconds: 15 });
  assert.equal(waited.runs[0].state, "completed");
  for (const receipt of waited._pi_delivery.receipts) await client.call("pi_release", { receipt });
  const original = await client.call("pi_agent_result", { run_id: first.run_id }, undefined, { consume: false });
  const view = await client.call("pi_view", { agent_id: first.agent_id });
  const before = status(f.runtime, f.state), bridge = client.bridge.child.pid;
  const watched = await client.call("pi_watch", {}, undefined, { passive: true });
  assert.ok(watched.notifications.some(row => row.run_id === first.run_id), "unconsumed terminal attention survives parking");
  await assert.rejects(client.call("pi_watch", { after: watched.cursor }, undefined, { passive: true }), isDaemonIdle);
  const deadline = Date.now() + 10000;
  while (status(f.runtime, f.state) && Date.now() < deadline) await sleep(50);
  assert.equal(status(f.runtime, f.state), undefined);
  assert.equal(client.bridge.child.pid, bridge, "test keeps the old helper to exercise authenticated per-operation rebind");
  const follow = await client.call("pi_followup_task", { agent_id: first.agent_id, message: "parking-followup-sentinel", request_id: "parking-followup" });
  assert.equal(follow.agent_id, first.agent_id); assert.notEqual(follow.run_id, first.run_id);
  assert.notEqual(status(f.runtime, f.state).pid, before.pid);
  const done = await client.call("pi_wait_agent", { run_ids: [follow.run_id], timeout_seconds: 15 });
  assert.equal(done.runs[0].state, "completed");
  const restored = await client.call("pi_view", { agent_id: first.agent_id });
  assert.equal(restored.session_file, view.session_file); assert.equal(restored.agent.generation, 2);
  const users = restored.messages.filter(row => row.message.role === "user").map(row => JSON.stringify(row.message.content));
  assert.equal(users.filter(text => text.includes("parking-original-sentinel")).length, 1, "old input was not replayed");
  assert.equal(users.filter(text => text.includes("parking-followup-sentinel")).length, 1);
  assert.equal((await client.call("pi_agent_result", { run_id: first.run_id }, undefined, { consume: false })).result_sha256, original.result_sha256);
  assert.ok((await client.call("pi_watch", {})).notifications.some(row => row.run_id === first.run_id), "old unseen completion still awaits delivery after restart");
});

test("passive initialization neither starts a daemon nor poisons later foreground calls; helper parking is reusable", { timeout: 30000 }, async t => {
  const f = await fixture(t), { client } = f;
  await assert.rejects(client.call("pi_list_agents", {}, undefined, { passive: true }), isDaemonIdle);
  assert.equal(status(f.runtime, f.state), undefined);
  const child = client.bridge.child;
  assert.equal((await client.call("pi_list_agents", {})).agents.length, 0);
  assert.equal(client.bridge.child, child, "rejected passive initialization can be retried in the same helper");
  const source = status(f.runtime, f.state); assert.ok(source.pid);
  let lateWrite; const write = child.stdin.write.bind(child.stdin);
  t.mock.method(child.stdin, "write", (body, callback) => {
    if (JSON.parse(body).park) { lateWrite = callback; return write(body, () => {}); }
    return write(body, callback);
  });
  await client.park();
  assert.notEqual(child.exitCode, null); assert.equal(client.bridge, undefined);
  assert.equal((await client.call("pi_list_agents", {})).agents.length, 0);
  lateWrite(new Error("controlled old-helper EPIPE"));
  assert.equal((await client.call("pi_list_agents", {})).agents.length, 0, "late write failure cannot close the replacement");
  assert.equal(status(f.runtime, f.state).pid, source.pid, "parking a frontend helper does not stop a shared backend");
});

test("a parked helper cannot replace a later frontend's lease when reconnecting", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.client.call("pi_list_agents", {}); await f.client.park();
  const later = new SubagentClient(f.runtime, f.ctx, f.dir, f.client.scope, () => {}); f.clients.push(later);
  await later.call("pi_list_agents", {});
  await assert.rejects(f.client.call("pi_list_agents", {}), error => error instanceof RuntimeError && error.code === "parent_stale");
  assert.equal((await later.call("pi_list_agents", {})).agents.length, 0, "old reconnect did not take the live owner back");
});

for (const failureAt of ["journal", "reply"]) test(`a failed binding ${failureAt} cannot turn reconnect into ownership takeover`, { timeout: 30000 }, async t => {
  const f = await fixture(t), failure = new Error(`controlled ${failureAt} failure`);
  if (failureAt === "reply") await f.client.call("pi_list_agents", {});
  const original = new SubagentClient(f.runtime, f.ctx, f.dir, f.client.scope, () => { if (failureAt === "journal") throw failure; }); f.clients.push(original);
  if (failureAt === "reply") {
    const rpc = original.rpc.bind(original);
    original.rpc = async (operation, ...args) => {
      const result = await rpc(operation, ...args);
      if (operation === "initialize") throw failure; // Binding committed, but caller never receives its result.
      return result;
    };
  }
  await assert.rejects(original.call("pi_list_agents", {}), error => error === failure);
  assert.ok(original.scope); await original.park();
  const later = new SubagentClient(f.runtime, f.ctx, f.dir, original.scope, () => {}); f.clients.push(later);
  await later.call("pi_list_agents", {});
  await assert.rejects(original.call("pi_list_agents", {}), error => error instanceof RuntimeError && error.code === "parent_stale");
  assert.equal((await later.call("pi_list_agents", {})).agents.length, 0);
});

test("closing during parking cannot restart a helper for waiting foreground work", { timeout: 30000 }, async t => {
  const f = await fixture(t), { client } = f;
  await client.call("pi_list_agents", {});
  let release; const stopped = new Promise(resolve => { release = resolve; }), stop = client.stopChild.bind(client);
  client.stopChild = async child => { await stopped; await stop(child); };
  const parking = client.park(), closed = client.close();
  const waiting = assert.rejects(client.call("pi_list_agents", {}), /frontend closed/);
  release(); await Promise.all([parking, closed, waiting]);
  assert.equal(client.bridge, undefined, "a logical close cannot create a replacement");
});

test("native session parks its helper silently and automatic boundaries do not restart an empty daemon", { timeout: 30000 }, async t => {
  const f = await fixture(t), warnings = [];
  const ctx = { ...f.ctx, mode: "rpc", isIdle: () => false, hasPendingMessages: () => false,
    ui: { notify: text => warnings.push(text), setStatus() {}, setWidget() {} } };
  const owner = new SubagentSession({ appendEntry() {}, sendMessage() {} }, f.runtime, ctx, f.dir);
  try {
    assert.equal((await owner.execute("pi_list_agents", {}, "list-before-idle", ctx)).isError, false);
    const deadline = Date.now() + 15000;
    while ((owner.syncState !== "parked" || owner.watching || status(f.runtime, f.state)) && Date.now() < deadline) {
      await owner.boundary({ type: "turn_end", outcome: "completed", entries: [] }, ctx);
      await owner.settled(ctx);
      await sleep(50);
    }
    assert.equal(owner.syncState, "parked"); assert.equal(owner.watching, undefined);
    assert.equal(owner.client.bridge, undefined, "the frontend-owned IPC process also exited");
    assert.equal(status(f.runtime, f.state), undefined); assert.deepEqual(warnings, []);
    for (const type of ["turn_end", "agent_before_settle"]) await owner.boundary({ type, outcome: "completed", entries: [] }, ctx);
    await owner.settled(ctx, true);
    assert.equal(status(f.runtime, f.state), undefined, "automatic parent events did not create a restart loop");
    assert.equal((await owner.execute("pi_list_agents", {}, "list-after-idle", ctx)).isError, false);
    assert.ok(status(f.runtime, f.state).pid, "an explicit request wakes and reauthenticates the daemon");
    assert.deepEqual(warnings, []);
  } finally { await owner.close(); }
});
