import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import goalExtension from "../../extensions/goal.ts";

test.beforeEach((t) => {
  (t as TestContext).mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
});

function makeHost(t: TestContext) {
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const entries: { type: string; data: any }[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const sent: unknown[] = [];

  const pi = {
    events: createEventBus(),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
    registerTool: (definition: { name: string }) => tools.set(definition.name, definition),
    sendMessage: (message: unknown) => sent.push(message),
  };

  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: (): Array<{ type: string; customType?: string; data?: unknown }> => [], getSessionId: () => "goal-test-session" },
    hasPendingMessages: () => false,
    isIdle: () => true,
    ui: {
      theme: { fg: (_key: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
      notify: () => {},
      confirm: async () => false,
      editor: async (): Promise<string | undefined> => undefined,
    },
  };

  goalExtension(pi as never);
  t.after(() => handlers.get("session_shutdown")!({}, ctx));

  return {
    ctx,
    events: pi.events,
    statusCalls,
    entries,
    sent,
    command: async (args: string) => await commands.get("goal")!.handler(args, ctx),
    tools,
    tool: async (action: string, params: Record<string, unknown> = {}) =>
      await tools.get("goal")!.execute(`call-${action}`, { action, ...params }, undefined, undefined, ctx),
    fire: async (event: string, ...args: unknown[]) => await handlers.get(event)!(...args),
    lastStatus: () => statusCalls.at(-1)?.text,
  };
}

/** Mock timers tick in whole steps, so each second is one scheduler advance. */
function tick(t: TestContext, seconds: number): void {
  for (let i = 0; i < seconds; i += 1) t.mock.timers.tick(1000);
}

test("goal validates action-specific fields without mutating state on invalid requests", async (t) => {
  const h = makeHost(t);
  assert.deepEqual([...h.tools.keys()], ["goal"]);
  assert.equal((await h.tool("get")).details.goal, null);
  for (const [action, params, error] of [
    ["create", {}, /requires objective/],
    ["create", { objective: " " }, /must not be empty/],
    ["create", { objective: "invalid budget", token_budget: 0 }, /positive integers/],
    ["update", {}, /requires status complete or blocked/],
    ["update", { status: "paused" }, /requires status complete or blocked/],
    ["pause", {}, /action must be/],
  ] as const) {
    await assert.rejects(() => h.tool(action, params), error);
  }
  const definition = h.tools.get("goal")!;
  const invalidArguments: Record<string, string>[] = [{}, { action: "pause" }, { action: "update", status: "paused" }];
  for (const arguments_ of invalidArguments) {
    assert.throws(() => validateToolArguments(definition, { type: "toolCall", id: "invalid", name: "goal", arguments: arguments_ }), /Validation failed/);
  }
  assert.equal(h.entries.length, 0, "invalid requests and reads do not persist changes");
  assert.equal((await h.tool("get")).details.goal, null);
});

test("goal keeps unfinished targets, permits completed replacement and guides continuations through update", async (t) => {
  const h = makeHost(t);
  const first = (await h.tool("create", { objective: "finish the whole objective", token_budget: 100 })).details;
  assert.equal(first.goal.status, "active");
  assert.equal(first.remainingTokens, 100);
  const entries = h.entries.length;
  assert.deepEqual((await h.tool("get")).details, first);
  assert.equal(h.entries.length, entries, "get is read-only");
  await assert.rejects(() => h.tool("create", { objective: "must not replace active" }), /unfinished goal/);
  const prompt = (await h.fire("before_agent_start", { systemPrompt: "BASE" }, h.ctx)).systemPrompt;
  assert.match(prompt, /call goal with action "update" and status "complete"/);
  assert.match(prompt, /at least three consecutive goal turns/);
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", { messages: [] }, h.ctx);
  const continuation = (h.sent.at(-1) as { content: string }).content;
  assert.match(continuation, /call goal with action "update" and status "complete"/);
  assert.match(continuation, /goal with action "update" and status "blocked"/);
  await h.tool("update", { status: "blocked" });
  assert.equal((await h.tool("get")).details.goal.status, "blocked");
  await assert.rejects(() => h.tool("create", { objective: "must not replace blocked" }), /unfinished goal/);
  await h.tool("update", { status: "complete" });
  const next = (await h.tool("create", { objective: "the next objective" })).details;
  assert.equal(next.goal.objective, "the next objective");
  assert.equal(next.goal.status, "active");
  assert.equal(next.goal.tokensUsed, 0);
  assert.equal(next.goal.tokenBudget, null);
});

test("one goal accounts running time, restores paused edits and completes its final turn", async (t) => {
  const h = makeHost(t);
  await h.fire("session_start", {}, h.ctx);
  await h.command("ship the ticking clock");
  await h.fire("agent_start", {}, h.ctx);
  assert.equal(h.lastStatus(), "Pursuing goal (0s)");
  tick(t, 3);
  assert.deepEqual(h.statusCalls.slice(-3).map((call) => call.text), ["Pursuing goal (1s)", "Pursuing goal (2s)", "Pursuing goal (3s)"]);
  await h.fire("agent_end", { messages: [] }, h.ctx);
  const accounts = h.entries.filter((entry) => entry.type === "goal" && entry.data.action === "account");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].data.goal.timeUsedSeconds, 3, "status reads do not double-count time");

  await h.fire("agent_start", {}, h.ctx);
  tick(t, 2);
  await h.command("pause");
  assert.equal(h.lastStatus(), "Goal paused (/goal resume)");
  const saved = structuredClone(h.entries.at(-1)!.data);
  h.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: saved }];
  await h.fire("session_tree", {}, h.ctx);
  h.ctx.ui.editor = async () => "edited while paused";
  await h.command("edit");
  const paused = h.statusCalls.length;
  tick(t, 5);
  assert.equal(h.statusCalls.length, paused, "paused goals do not refresh");
  let goal = (await h.tool("get")).details.goal;
  assert.equal(goal.status, "paused");
  assert.equal(goal.timeUsedSeconds, 5, "pause accounts the interrupted turn before branch restore");
  assert.equal(goal.objective, "edited while paused");
  await h.command("resume");
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 1);
  assert.equal(h.lastStatus(), "Pursuing goal (6s)", "resume excludes the paused interval");
  await h.tool("update", { status: "complete" });
  await h.fire("agent_end", { messages: [{ role: "assistant", usage: { totalTokens: 7 } }] }, h.ctx);
  goal = (await h.tool("get")).details.goal;
  assert.equal(goal.status, "complete", "final accounting must not reopen a completed goal");
  assert.equal(goal.tokensUsed, 7);
  assert.equal(goal.timeUsedSeconds, 6);
  assert.equal(h.lastStatus(), "Goal complete");
  const complete = h.statusCalls.length;
  tick(t, 5);
  assert.equal(h.statusCalls.length, complete, "completed goals do not refresh");
});

test("shutdown stops the active refresh and reload only refreshes the new context", async (t) => {
  const timers = t.mock.method(globalThis, "setInterval");
  const cleared = t.mock.method(globalThis, "clearInterval");
  const previous = makeHost(t);
  await previous.command("survive a reload without retaining its UI");
  tick(t, 1);
  const saved = structuredClone(previous.entries.at(-1)!.data);
  await previous.fire("session_shutdown", {}, previous.ctx);
  await previous.fire("session_shutdown", {}, previous.ctx);
  const stopped = previous.statusCalls.length;

  const reloaded = makeHost(t);
  reloaded.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: saved }];
  await reloaded.fire("session_start", {}, reloaded.ctx);
  const started = reloaded.statusCalls.length;
  tick(t, 3);
  assert.equal(previous.statusCalls.length, stopped, "the disposed extension must not refresh its old UI");
  assert.equal(reloaded.statusCalls.length, started + 3, "exactly one timer refreshes the replacement UI");
  await reloaded.fire("session_shutdown", {}, reloaded.ctx);
  assert.deepEqual(cleared.mock.calls.map((call) => call.arguments[0]), timers.mock.calls.map((call) => call.result));
});

test("turn accounting stays with the goal that started the turn and stops at its budget", async (t) => {
  const h = makeHost(t);
  await h.tool("create", { objective: "old goal" });
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 2);
  await h.command("clear");
  await h.tool("create", { objective: "new goal", token_budget: 20 });
  // Pi input is uncached input: 5 measured + 10 cached + 15 output.
  const messages = [{ role: "assistant", stopReason: "stop", usage: { input: 5, cacheRead: 10, output: 15 } }];
  await h.fire("agent_end", { messages }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.tokensUsed, 0);
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 3);
  await h.fire("agent_end", { messages }, h.ctx);
  const result = (await h.tool("get")).details;
  assert.equal(result.goal.tokensUsed, 20);
  assert.equal(result.goal.timeUsedSeconds, 3);
  assert.equal(result.goal.status, "budgetLimited");
  assert.equal(result.remainingTokens, 0);
  assert.equal(h.entries.at(-1)?.data.action, "account");
  const sent = h.sent.length;
  tick(t, 2);
  assert.equal(h.sent.length, sent, "a budget-limited goal does not continue");
});

test("settled errors stop continuation and context keeps only the current goal's last continuation", async (t) => {
  const h = makeHost(t);
  await h.command("keep the right continuation");
  const first = structuredClone(h.sent.at(-1));
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
  const last = structuredClone(h.sent.at(-1));
  const user = { role: "user", content: "keep" };
  const filtered = await h.fire("context", { messages: [first, user, { customType: "goal-ui" }, last] });
  assert.deepEqual(filtered.messages, [user, last]);
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limit" }] }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.status, "active");
  await h.fire("agent_settled", { aborted: false }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.status, "usageLimited");
  assert.deepEqual((await h.fire("context", { messages: [first, user, last] })).messages, [user]);
});

test("completion reports settled final-turn usage instead of the provisional tool snapshot", async (t) => {
  const h = makeHost(t);
  await h.tool("create", { objective: "finish with accurate final usage", token_budget: 100 });
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", { messages: [{ role: "assistant", usage: { input: 80, output: 0 } }] }, h.ctx);
  await h.fire("agent_start", {}, h.ctx);
  const receipt = (await h.tool("update", { status: "complete" })).details;
  assert.equal(receipt.goal.tokensUsed, 80);
  assert.match(receipt.completionBudgetReport, /excludes the active turn/);
  assert.equal(h.sent.filter((message: any) => message.customType === "goal-ui").length, 0);
  await h.fire("agent_end", { messages: [{ role: "assistant", usage: { input: 25, output: 0 } }] }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.tokensUsed, 105);
  assert.match((h.sent.at(-1) as { content: string }).content, /Final usage: tokens used: 105 of 100/);
  const reports = h.sent.length;
  await h.fire("agent_end", { messages: [] }, h.ctx);
  assert.equal(h.sent.length, reports, "a settled completion reports once");
});

test("an internally invalidated checkpoint request leaves Goal active without a competing continuation", async (t) => {
  const h = makeHost(t);
  await h.command("preserve the active goal during context recovery");
  await h.fire("agent_start", {}, h.ctx);
  const sent = h.sent.length;
  h.ctx.ui.confirm = async () => { assert.fail("an internal cancellation is not a user abort"); };
  h.events.emit("metis:checkpoint-request-cancelled", {});
  await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx);
  await h.fire("agent_settled", { aborted: true }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.status, "active");
  assert.equal(h.sent.length, sent, "the user retry must rebuild one fresh request");
});

test("a goal stays active through all five attempts and blocks only after final settlement", async (t) => {
  const h = makeHost(t);
  await h.command("survive transient Codex errors");
  const sent = h.sent.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    await h.fire("agent_start", {}, h.ctx);
    tick(t, 1);
    await h.fire("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "Codex error: You can retry your request." }],
    }, h.ctx);
    assert.equal((await h.tool("get")).details.goal.status, "active");
    assert.equal(h.sent.length, sent, "goal continuation must not compete with native retry");
  }
  await h.fire("agent_settled", { aborted: false }, h.ctx);
  const goal = (await h.tool("get")).details.goal;
  assert.equal(goal.status, "blocked");
  assert.equal(goal.timeUsedSeconds, 5);
  const statuses = h.entries.filter(entry => entry.data.action === "status");
  assert.equal(statuses.length, 1);
  await h.fire("agent_settled", { aborted: false }, h.ctx);
  assert.equal(h.entries.filter(entry => entry.data.action === "status").length, 1);
});

test("a successful retry clears the failed attempt and resumes goal continuation", async (t) => {
  const h = makeHost(t);
  await h.command("continue after recovery");
  const sent = h.sent.length;
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }],
  }, h.ctx);
  assert.equal(h.sent.length, sent);
  await h.fire("agent_start", {}, h.ctx);
  await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx);
  assert.equal(h.sent.length, sent + 1);
  await h.fire("agent_settled", { aborted: false }, h.ctx);
  assert.equal((await h.tool("get")).details.goal.status, "active");
  assert.equal(h.entries.filter(entry => entry.data.action === "status").length, 0);
});

for (const action of ["pause", "replace", "restore", "abort"] as const) {
  test(`a pending retry error does not override goal ${action}`, async (t) => {
    const h = makeHost(t);
    await h.command("keep stale errors away");
    await h.fire("agent_start", {}, h.ctx);
    await h.fire("agent_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "terminated" }],
    }, h.ctx);
    if (action === "pause") await h.command("pause");
    if (action === "replace") {
      await h.command("clear");
      await h.command("new goal");
    }
    if (action === "restore") {
      const saved = structuredClone(h.entries.at(-1)!.data);
      h.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: saved }];
      await h.fire("session_tree", {}, h.ctx);
    }
    await h.fire("agent_settled", { aborted: action === "abort" }, h.ctx);
    assert.equal((await h.tool("get")).details.goal.status, action === "pause" ? "paused" : "active");
  });
}
