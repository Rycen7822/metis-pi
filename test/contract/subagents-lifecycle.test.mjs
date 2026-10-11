import test from "node:test";
import assert from "node:assert/strict";
import { SubagentSession } from "../../src/subagents/session.ts";
import { RuntimeError, SubagentClient } from "../../src/subagents/client.ts";

const runtime = { root: "/unused-test-runtime", tools: [], baseEnvKeys: [], scopeEnvKeys: [], maxFrame: 8 * 1024 * 1024 };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(probe) {
  const end = Date.now() + 1500;
  while (!probe() && Date.now() < end) await tick();
  assert.ok(probe(), "bounded lifecycle condition reached");
}
function fixture(t, call) {
  const warnings = [],
    operations = [];
  t.mock.method(SubagentClient.prototype, "call", async function (op, params, signal, extra) {
    operations.push({ op, extra });
    return call(op, params, signal, extra);
  });
  const branch = [
    { type: "custom", customType: "metis-subagent-scope", data: { sessionId: "lifecycle-test", scope: "scope_test" } },
  ];
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => "lifecycle-test", getBranch: () => branch },
    ui: { notify: (text, level) => warnings.push({ text, level }), setWidget() {}, setStatus() {} },
  };
  const owner = new SubagentSession({ appendEntry() {}, sendMessage() {} }, runtime, ctx, "/unused-test-agent-dir");
  t.after(() => owner.close());
  const boundary = (type) => owner.boundary({ type, outcome: "completed", entries: [] }, ctx);
  return { owner, ctx, warnings, operations, boundary, branch };
}
function heldWatch(signal) {
  return new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("closed test watch")), { once: true }),
  );
}

for (const error of [
  new RuntimeError({ code: "version_mismatch", message: "controlled stale daemon" }),
  new Error("unknown connection failure"),
]) {
  test(
    "watch failure pauses automatic callbacks once without hiding explicit " +
      `${error instanceof RuntimeError ? "runtime" : "unknown"}` +
      " errors",
    async (t) => {
      const f = fixture(t, async () => {
        throw error;
      });
      await until(() => f.warnings.length === 1);
      for (let i = 0; i < 3; i++) {
        assert.equal(await f.boundary("turn_end"), undefined);
        assert.equal(await f.boundary("agent_before_settle"), undefined);
        await f.owner.settled(f.ctx, true);
      }
      assert.equal(f.warnings.length, 1);
      assert.equal(f.warnings[0].level, "warning");
      assert.deepEqual(
        f.operations.map((row) => row.op),
        ["pi_watch"],
      );
      if (error instanceof RuntimeError) {
        const result = await f.owner.execute("pi_list_agents", {}, "test-call", f.ctx);
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).error.code, "version_mismatch");
      } else
        await assert.rejects(f.owner.execute("pi_list_agents", {}, "test-call", f.ctx), (value) => value === error);
      assert.equal(f.warnings.length, 1);
    },
  );
}

test("a boundary failure shares the same degraded state as a concurrent watch failure", async (t) => {
  const error = new RuntimeError({ code: "version_mismatch", message: "same cached initialization failure" });
  let rejectWatch;
  const f = fixture(t, async (op) => {
    if (op === "pi_watch")
      return new Promise((_, reject) => {
        rejectWatch = reject;
      });
    throw error;
  });
  await until(() => rejectWatch);
  assert.equal(await f.boundary("turn_end"), undefined);
  rejectWatch(error);
  await tick();
  await f.owner.settled(f.ctx, true);
  await f.boundary("agent_before_settle");
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(
    f.operations.map((row) => row.op),
    ["pi_watch", "pi_claim"],
  );
});

test("a successful in-flight watch reply cannot resume synchronization after a boundary failure", async (t) => {
  let resolveWatch;
  const f = fixture(t, async (op) => {
    if (op === "pi_watch")
      return new Promise((resolve) => {
        resolveWatch = resolve;
      });
    throw new Error("controlled boundary failure");
  });
  await until(() => resolveWatch);
  await f.boundary("turn_end");
  resolveWatch({ cursor: "old", notifications: [], agents: [] });
  await until(() => !f.owner.watching);
  assert.equal(f.warnings.length, 1); assert.equal(f.owner.syncState, "failed");
  assert.deepEqual(f.operations.map(row => row.op), ["pi_watch", "pi_claim"]);
});

test("an empty in-flight claim cannot clear a concurrent watch failure", async t => {
  let rejectWatch, resolveClaim;
  const f = fixture(t, async op => new Promise((resolve, reject) => {
    if (op === "pi_watch") rejectWatch = reject; else resolveClaim = resolve;
  }));
  await until(() => rejectWatch);
  const boundary = f.boundary("turn_end"); await until(() => resolveClaim);
  rejectWatch(new Error("watch failed first")); await until(() => f.warnings.length === 1);
  resolveClaim({ events: [] }); await boundary; await until(() => !f.owner.watching);
  assert.equal(f.owner.syncState, "failed"); assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.operations.map(row => row.op), ["pi_watch", "pi_claim"]);
});

test("a claim persisted after daemon parking still reconciles its receipt before being forgotten", async t => {
  let rejectWatch, watches = 0, observes = 0;
  const f = fixture(t, async (op, _params, signal, extra) => {
    if (op === "pi_watch") {
      if (++watches === 1) return new Promise((_, reject) => { rejectWatch = reject; });
      if (watches === 2) throw new RuntimeError({ code: "daemon_idle", message: "parked" });
      return heldWatch(signal);
    }
    if (op === "pi_claim") return { id: "delivery_claim", events: [{ notification_id: "notice", run_id: "run_done" }], runs: [], questions: [] };
    assert.equal(op, "pi_observe"); assert.equal(extra.passive, false, "known saved receipt can wake a parked daemon"); observes++; return {};
  });
  await until(() => rejectWatch);
  const response = await f.boundary("turn_end");
  rejectWatch(new RuntimeError({ code: "daemon_idle", message: "old watch" }));
  await until(() => f.owner.syncState === "parked" && !f.owner.watching);
  assert.equal(f.owner.claims.size, 1);
  f.branch.push(response.entries[0]);
  await f.owner.settled(f.ctx, true); await until(() => watches === 3);
  assert.equal(observes, 1); assert.equal(f.owner.claims.size, 0); assert.deepEqual(f.warnings, []);
});

test("an unpersisted automatic claim becomes uncertain at final settlement instead of waking forever", async t => {
  let uncertain = 0;
  const f = fixture(t, async (op, params, signal) => {
    if (op === "pi_watch") return heldWatch(signal);
    if (op === "pi_claim") return { id: "delivery_unsaved", events: [{ notification_id: "notice", run_id: "run_done" }], runs: [], questions: [] };
    assert.equal(op, "pi_uncertain"); assert.equal(params.receipt, "delivery_unsaved"); uncertain++; return {};
  });
  await until(() => f.operations.length);
  await f.boundary("turn_end"); assert.equal(f.owner.claims.size, 1);
  await f.owner.settled(f.ctx, true);
  assert.equal(uncertain, 1); assert.equal(f.owner.claims.size, 0); assert.deepEqual(f.warnings, []);
});

test("a normal idle reply cannot undo a real synchronization failure", async t => {
  let rejectWatch;
  const f = fixture(t, async op => {
    if (op === "pi_watch") return new Promise((_, reject) => { rejectWatch = reject; });
    throw new Error("real boundary failure");
  });
  await until(() => rejectWatch); await f.boundary("turn_end");
  rejectWatch(new RuntimeError({ code: "daemon_idle", message: "concurrent normal exit" }));
  await until(() => !f.owner.watching);
  assert.equal(f.owner.syncState, "failed"); assert.equal(f.warnings.length, 1);
});

test("a stale boundary idle reply cannot park newer explicit work", async t => {
  let rejectClaim;
  const f = fixture(t, async (op, _params, signal) => {
    if (op === "pi_watch") return heldWatch(signal);
    if (op === "pi_claim") return new Promise((_, reject) => { rejectClaim = reject; });
    return { agents: [] };
  });
  await until(() => f.operations.length);
  const boundary = f.boundary("turn_end"); await until(() => rejectClaim);
  await f.owner.execute("pi_list_agents", {}, "new-foreground", f.ctx);
  rejectClaim(new RuntimeError({ code: "daemon_idle", message: "old boundary" })); await boundary;
  assert.equal(f.owner.syncState, "active"); assert.deepEqual(f.warnings, []);
});

test("a successful explicit answer resumes the same synchronization policy as other tools", async t => {
  const f = fixture(t, async (op, _params, signal) => {
    if (op === "pi_watch") return heldWatch(signal);
    if (op === "pi_inspect_agent") return { run: { id: "run" } };
    if (op === "pi_wait_agent") return { questions: [{ id: "question", method: "select", title: "Choose", options: ["yes"] }] };
    return {};
  });
  f.ctx.hasUI = true; f.ctx.ui.select = async () => "yes";
  await until(() => f.operations.length);
  f.owner.synchronizationFailed(new Error("previous synchronization failure"));
  await f.owner.command("answer agent", f.ctx);
  assert.equal(f.owner.syncState, "active"); assert.equal(f.warnings.length, 1);
  assert.ok(f.operations.some(row => row.op === "pi_answer_agent"));
});

test("watch delivery queued behind a failing boundary cannot bypass the automatic gate", async t => {
  let finishWatch, rejectClaim, claims = 0;
  const f = fixture(t, async op => {
    if (op === "pi_watch") return new Promise(resolve => { finishWatch = resolve; });
    if (op === "pi_claim" && ++claims === 1) return new Promise((_, reject) => { rejectClaim = reject; });
    return { events: [] };
  });
  await until(() => finishWatch); f.ctx.isIdle = () => true;
  const boundary = f.boundary("turn_end"); await until(() => rejectClaim);
  finishWatch({ cursor: "queued", agents: [], notifications: [] }); await tick();
  rejectClaim(new Error("boundary failure after watch delivery was queued"));
  await boundary; await until(() => !f.owner.watching);
  assert.equal(f.owner.syncState, "failed"); assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.operations.map(row => row.op), ["pi_watch", "pi_claim"]);
});

test("helper parking errors warn once and still clear the watcher", async t => {
  const f = fixture(t, async () => { throw new RuntimeError({ code: "daemon_idle", message: "normal idle" }); });
  t.mock.method(SubagentClient.prototype, "park", async () => { throw new Error("controlled parking failure"); });
  await until(() => !f.owner.watching);
  assert.equal(f.owner.syncState, "failed"); assert.equal(f.warnings.length, 1);
  const count = f.operations.length;
  await f.boundary("turn_end"); await f.owner.settled(f.ctx, true);
  assert.equal(f.operations.length, count);
});

test("normal parking is silent and only foreground activity resumes a passive watch", async t => {
  let watches = 0;
  const f = fixture(t, async (op, _params, signal, extra) => {
    if (op === "pi_watch") {
      assert.equal(extra.passive, true);
      if (++watches === 1) throw new RuntimeError({ code: "daemon_idle", message: "parked" });
      return heldWatch(signal);
    }
    assert.equal(op, "pi_list_agents"); return { agents: [] };
  });
  await until(() => f.owner.syncState === "parked" && !f.owner.watching);
  await f.boundary("turn_end"); await f.owner.settled(f.ctx, true);
  assert.equal(f.operations.length, 1); assert.deepEqual(f.warnings, []);
  const result = await f.owner.execute("pi_list_agents", {}, "test-call", f.ctx);
  assert.equal(result.isError, false);
  await until(() => watches === 2);
  assert.deepEqual(f.warnings, []);
});

test("an old idle-watch response cannot park newer foreground work", async t => {
  let watches = 0, rejectOld;
  const f = fixture(t, async (op, _params, signal) => {
    if (op !== "pi_watch") return { agents: [] };
    if (++watches === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return heldWatch(signal);
  });
  await until(() => rejectOld);
  await f.owner.execute("pi_list_agents", {}, "test-call", f.ctx);
  rejectOld(new RuntimeError({ code: "daemon_idle", message: "stale idle response" }));
  await until(() => watches === 2);
  assert.equal(f.owner.syncState, "active"); assert.deepEqual(f.warnings, []);
});

test("foreground work arriving during helper parking restarts the watch after detach", async t => {
  let releasePark, parking = false, watches = 0;
  t.mock.method(SubagentClient.prototype, "park", async () => {
    parking = true; await new Promise(resolve => { releasePark = resolve; });
  });
  const f = fixture(t, async (op, _params, signal) => {
    if (op !== "pi_watch") return { agents: [] };
    if (++watches === 1) throw new RuntimeError({ code: "daemon_idle", message: "parked" });
    return heldWatch(signal);
  });
  await until(() => parking);
  await f.owner.execute("pi_list_agents", {}, "test-call", f.ctx);
  releasePark(); await until(() => watches === 2);
  assert.equal(f.owner.syncState, "active"); assert.deepEqual(f.warnings, []);
});
