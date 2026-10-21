import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { subagentTheme } from "../helpers/subagent-theme.mjs";
import { SubagentSession } from "../../src/subagents/host/session.ts";
import { RuntimeError, SubagentClient } from "../../src/subagents/host/client.ts";
import { runtimePackage } from "../../src/subagents/host/runtime-package.ts";
import managedSurface from "../../src/subagents/worker/managed-surface.ts";

test("managed children reject current and legacy recursive tool calls, including namespace wrappers", async t => {
  const names = ["PI_AGENTS_HOST", "PI_AGENTS_CHILD_ACCESS", "PI_AGENTS_CHILD_BUILTINS"];
  const previous = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
  }));
  process.env.PI_AGENTS_HOST = "pi";
  process.env.PI_AGENTS_CHILD_ACCESS = "write";
  process.env.PI_AGENTS_CHILD_BUILTINS = "";
  t.mock.method(process.stderr, "write", () => true);
  const handlers = new Map();
  await managedSurface({
    on: (event, handler) => handlers.set(event, handler),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
  });
  const check = toolName => handlers.get("tool_call")({ toolName, input: {} });
  for (const name of ["subagents_spawn_agent", "subagents_followup_task", "subagents_send_message",
    "pi_spawn_agent", "mcp__pi_spawn_agent", "mcp__subagents_send_message"]) {
    assert.equal(check(name)?.block, true, `${name} cannot delegate from a managed child`);
  }
  assert.equal(check("subagents_spawn_agent_notes"), undefined, "unrelated ambient tools are not blocked by a partial name");
});

const runtime = { root: "/unused-test-runtime", tools: [], baseEnvKeys: [], scopeEnvKeys: [], maxFrame: 8 * 1024 * 1024 };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(probe) {
  const end = Date.now() + 1500;
  while (!probe() && Date.now() < end) await tick();
  assert.ok(probe(), "bounded lifecycle condition reached");
}
function fixture(t, call, agentDir = "/unused-test-agent-dir") {
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
  const owner = new SubagentSession({ appendEntry() {}, sendMessage() {} }, runtime, ctx, agentDir);
  t.after(() => owner.close());
  const boundary = (type) => owner.boundary({ type, outcome: "completed", entries: [] }, ctx);
  return { owner, ctx, warnings, operations, boundary, branch };
}
function heldWatch(signal) {
  return new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("closed test watch")), { once: true }),
  );
}

test("the widget uses Bubbles cadence without backend polling or remounting and stops when closed", async t => {
  const previous = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
  t.mock.timers.enable({ apis: ["setInterval"] });
  let watches = 0, publishUpdate;
  const f = fixture(t, async (op, _params, signal) => {
    if (op !== "pi_watch") return {};
    if (watches++) {
      if (watches === 2) return new Promise(resolve => { publishUpdate = resolve; });
      return heldWatch(signal);
    }
    return { cursor: 1, agents: [{ id: "spinner", name: "worker", state: "running" }], notifications: [] };
  });
  let renders = 0, mounts = 0, widget;
  f.ctx.mode = "tui";
  f.ctx.ui.setWidget = (_key, factory) => {
    if (factory) mounts++;
    widget = factory?.({ requestRender: () => { renders++; } }, subagentTheme);
  };
  await until(() => widget && watches === 2);
  const mounted = widget;
  publishUpdate({ cursor: 2, agents: [{ id: "spinner", name: "worker", state: "running", tool_uses: 1 }], notifications: [] });
  await until(() => watches === 3);
  assert.equal(widget, mounted, "watch snapshots preserve the mounted widget and its startup clock");
  assert.equal(mounts, 1);
  renders = 0;
  const calls = f.operations.length;
  t.mock.timers.tick(99);
  assert.equal(renders, 0);
  t.mock.timers.tick(1);
  assert.equal(renders, 1);
  t.mock.timers.tick(900);
  assert.equal(renders, 10);
  assert.equal(mounts, 1, "animation ticks keep the widget and its startup clock mounted");
  assert.equal(f.operations.length, calls, "animation ticks do not query the backend");
  await f.owner.close();
  assert.equal(widget, undefined);
  t.mock.timers.tick(1000);
  assert.equal(renders, 10, "closed sessions no longer request animation frames");
});

for (const policy of ["configuration", "NO_COLOR"]) {
  test(`${policy} disables motion and refreshes widget metadata only once per second`, async t => {
    const previous = process.env.NO_COLOR;
    if (policy === "NO_COLOR") process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
    t.after(() => { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; });
    t.mock.timers.enable({ apis: ["setInterval"] });
    const agentDir = mkdtempSync(join(tmpdir(), "metis-static-motion-"));
    t.after(() => rmSync(agentDir, { recursive: true, force: true }));
    if (policy === "configuration") {
      writeFileSync(join(agentDir, "metis-pi.toml"), "[appearance.working]\nanimation = false\n");
    }
    let watches = 0;
    const f = fixture(t, async (op, _params, signal) => {
      if (op !== "pi_watch") return {};
      if (watches++) return heldWatch(signal);
      return { cursor: 1, agents: [{ id: "spinner", name: "worker", state: "running" }], notifications: [] };
    }, agentDir);
    let renders = 0, widget;
    f.ctx.mode = "tui";
    f.ctx.ui.setWidget = (_key, factory) => {
      widget = factory?.({ requestRender: () => { renders++; } }, subagentTheme);
    };
    await until(() => widget && watches === 2);
    const first = widget.render(80), calls = f.operations.length;
    t.mock.timers.tick(999);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);
    assert.deepEqual(widget.render(80), first, "disabled animation keeps a visible static indicator");
    assert.equal(f.operations.length, calls, "metadata refresh does not query the backend");
    await f.owner.close();
    t.mock.timers.tick(1000);
    assert.equal(renders, 1, "static refresh also stops on close");
  });
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
        const result = await f.owner.execute("subagents_list_agents", {}, "test-call", f.ctx);
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).error.code, "version_mismatch");
      } else
        await assert.rejects(f.owner.execute("subagents_list_agents", {}, "test-call", f.ctx), (value) => value === error);
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

test("attention receipts and question answers require the same saved body proof", async t => {
  for (const variant of ["unchanged", "boundary_edit", "body_tamper", "foreign_session", "foreign_scope", "missing_receipt"]) {
    await t.test(variant, async t => {
      const manager = SessionManager.inMemory(process.cwd()), sessionId = manager.getSessionId();
      manager.appendCustomEntry("metis-subagent-scope", { sessionId, scope: "scope_test" });
      const question = { id: "question", agent_id: "agent", run_id: "run", generation: 1, name: "child" };
      const calls = [];
      t.mock.method(SubagentClient.prototype, "call", async (op, params, signal, extra) => {
        calls.push({ op, params, extra });
        if (op === "pi_watch") return heldWatch(signal);
        if (op === "pi_claim") return {
          id: "delivery_question",
          events: [{ notification_id: "notice", agent_id: "agent", run_id: "run", name: "child", event: "question", state: "needs_input" }],
          runs: [], questions: [question],
        };
        return { sent: true };
      });
      const ctx = {
        cwd: process.cwd(), mode: "rpc", sessionManager: manager,
        isIdle: () => false, hasPendingMessages: () => false,
        ui: { notify() {}, setWidget() {}, setStatus() {} },
      };
      const owner = new SubagentSession(
        { appendEntry: (type, data) => manager.appendCustomEntry(type, data), sendMessage() {} },
        { ...runtime, tools: runtimePackage().tools.filter(tool => tool.name === "subagents_answer_agent") },
        ctx, "/unused-test-agent-dir",
      );
      t.after(() => owner.close());
      const entries = variant === "boundary_edit" ? [{ type: "custom", customType: "another-boundary-entry", data: { note: "unrelated" } }] : [];
      const response = await owner.boundary({ type: "turn_end", outcome: "completed", entries }, ctx);
      const original = response.entries.find(entry => entry.type === "custom_message"), draft = structuredClone(original);
      if (variant === "body_tamper") draft.content = "The child question was removed by a later boundary handler.";
      if (variant === "foreign_session") draft.details.sessionId = "another-parent-session";
      if (variant === "foreign_scope") draft.details.scope = "scope_foreign";
      if (variant === "missing_receipt") delete draft.details.receipt;
      if (variant === "boundary_edit") draft.display = false;
      for (const entry of response.entries) {
        const saved = entry === original ? draft : entry;
        if (saved.type === "custom") manager.appendCustomEntry(saved.customType, saved.data);
        else manager.appendCustomMessageEntry(saved.customType, saved.content, saved.display, saved.details);
      }
      const serialize = t.mock.method(JSON, "stringify");
      const reads = () => serialize.mock.calls.filter(({ arguments: [value] }) => value === draft.content).length;
      await owner.settled(ctx, true);
      const valid = variant === "unchanged" || variant === "boundary_edit";
      assert.deepEqual(calls.filter(call => call.op === "pi_observe").map(call => call.params.receipt), valid ? ["delivery_question"] : []);
      assert.deepEqual(calls.filter(call => call.op === "pi_uncertain").map(call => call.params.receipt), valid ? [] : ["delivery_question"], "an unconfirmed body retains recoverable attention");
      const answer = () => owner.execute("subagents_answer_agent", { agent_id: "child", answer: "Use the current branch" }, "answer", ctx);
      const saved = manager.getBranch().findLast(entry => entry.type === "custom_message" && entry.customType === original.customType);
      const content = saved.content;
      if (valid) {
        assert.equal(reads(), 1, "first attention observation validates saved bytes");
        serialize.mock.resetCalls();
        await owner.settled(ctx);
        assert.equal(reads(), 0, "observed attention is not serialized again");
        saved.content += " Changed after observation.";
        await owner.settled(ctx);
      }
      const rejected = await answer();
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.error.code, "input_not_delivered", "answering always requires the current saved body proof");
      assert.equal(calls.filter(call => call.op === "subagents_answer_agent").length, 0, "a rejected proof must not answer the question");
      if (valid) saved.content = content;
      else {
        // Recovery uses the original saved delivery, not a new notification or new run.
        manager.appendCustomMessageEntry(original.customType, original.content, original.display, original.details);
        await owner.settled(ctx);
        assert.deepEqual(calls.filter(call => call.op === "pi_observe").map(call => call.params.receipt), ["delivery_question"]);
      }
      const answered = await answer();
      assert.equal(answered.isError, false);
      const dispatched = calls.find(call => call.op === "subagents_answer_agent");
      assert.equal(dispatched.params.ui_request_id, question.id);
      assert.deepEqual(dispatched.extra.question, { id: question.id, agent_id: question.agent_id, run_id: question.run_id, generation: question.generation });
    });
  }
});

test("reconciliation observes persisted journals once and validates new/mixed body proofs", async t => {
  const observed = [];
  const f = fixture(t, async (op, params, signal) => {
    if (op === "pi_watch") return heldWatch(signal);
    assert.equal(op, "pi_observe"); observed.push(params.receipt); return {};
  });
  await until(() => f.operations.some(call => call.op === "pi_watch"));
  const hash = content => createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const content = [{ type: "text", text: "saved é中👩🏽‍💻\n\u2028\u2029" }];
  const proof = { id: "old-tool", events: [], receipts: ["old-tool"], sessionId: "lifecycle-test",
    scope: "scope_test", digest: hash(content), isError: false };
  const tool = { role: "toolResult", toolCallId: "tool", toolName: "fixture", timestamp: 1,
    content, isError: false, details: { metisSubagentReceipt: proof } };
  f.branch.push({ type: "custom", customType: "metis-subagent-receipt", data: {
    sessionId: "lifecycle-test", scope: "scope_test", receipt: "delivery_saved",
  } }, { type: "message", message: tool });
  const serialize = t.mock.method(JSON, "stringify");
  const reads = () => serialize.mock.calls.filter(({ arguments: [value] }) => value === content).length;
  await f.owner.settled(f.ctx);
  assert.deepEqual(observed, ["delivery_saved", "old-tool"]);
  assert.equal(reads(), 1, "first observation validates saved bytes");
  serialize.mock.resetCalls();
  await f.owner.settled(f.ctx, true);
  assert.equal(reads(), 0, "fully observed content is not serialized again");

  // The same branch object must be revalidated when it gains an unobserved receipt.
  proof.receipts.push("new-tool");
  content[0].text += " changed";
  await f.owner.settled(f.ctx);
  assert.deepEqual(observed, ["delivery_saved", "old-tool"], "an observed identifier cannot bypass a mixed proof's digest");
  proof.digest = hash(content);
  for (const [target, key, value] of [
    [tool, "isError", true], [proof, "scope", "foreign"], [proof, "sessionId", "foreign"],
  ]) {
    const saved = target[key];
    target[key] = value;
    await f.owner.settled(f.ctx);
    assert.deepEqual(observed, ["delivery_saved", "old-tool"], `mixed proof requires matching ${key}`);
    target[key] = saved;
  }
  await f.owner.settled(f.ctx);
  assert.deepEqual(observed, ["delivery_saved", "old-tool", "new-tool"]);
  assert.deepEqual(f.warnings, []);
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
  await f.owner.execute("subagents_list_agents", {}, "new-foreground", f.ctx);
  rejectClaim(new RuntimeError({ code: "daemon_idle", message: "old boundary" })); await boundary;
  assert.equal(f.owner.syncState, "active"); assert.deepEqual(f.warnings, []);
});

test("a successful explicit answer resumes the same synchronization policy as other tools", async t => {
  const f = fixture(t, async (op, _params, signal) => {
    if (op === "pi_watch") return heldWatch(signal);
    if (op === "subagents_inspect_agent") return { run: { id: "run" } };
    if (op === "subagents_wait_agent") return { questions: [{ id: "question", method: "select", title: "Choose", options: ["yes"] }] };
    return {};
  });
  f.ctx.hasUI = true; f.ctx.ui.select = async () => "yes";
  await until(() => f.operations.length);
  f.owner.synchronizationFailed(new Error("previous synchronization failure"));
  await f.owner.command("answer agent", f.ctx);
  assert.equal(f.owner.syncState, "active"); assert.equal(f.warnings.length, 1);
  assert.ok(f.operations.some(row => row.op === "subagents_answer_agent"));
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
    assert.equal(op, "subagents_list_agents"); return { agents: [] };
  });
  await until(() => f.owner.syncState === "parked" && !f.owner.watching);
  await f.boundary("turn_end"); await f.owner.settled(f.ctx, true);
  assert.equal(f.operations.length, 1); assert.deepEqual(f.warnings, []);
  const result = await f.owner.execute("subagents_list_agents", {}, "test-call", f.ctx);
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
  await f.owner.execute("subagents_list_agents", {}, "test-call", f.ctx);
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
  await f.owner.execute("subagents_list_agents", {}, "test-call", f.ctx);
  releasePark(); await until(() => watches === 2);
  assert.equal(f.owner.syncState, "active"); assert.deepEqual(f.warnings, []);
});
