// Goal entry: commands, tools, refresh ownership, accounting and continuation.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
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
    statusCalls,
    entries,
    sent,
    command: async (args: string) => await commands.get("goal")!.handler(args, ctx),
    tool: async (name: string, params: Record<string, unknown>) =>
      await tools.get(name)!.execute(`call-${name}`, params, undefined, undefined, ctx),
    fire: async (event: string, ...args: unknown[]) => await handlers.get(event)!(...args),
    lastStatus: () => statusCalls.at(-1)?.text,
  };
}

/** Mock timers tick in whole steps, so each second is one scheduler advance. */
function tick(t: TestContext, seconds: number): void {
  for (let i = 0; i < seconds; i += 1) t.mock.timers.tick(1000);
}

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
  let goal = (await h.tool("get_goal", {})).details.goal;
  assert.equal(goal.status, "paused");
  assert.equal(goal.timeUsedSeconds, 5, "pause accounts the interrupted turn before branch restore");
  assert.equal(goal.objective, "edited while paused");
  await h.command("resume");
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 1);
  assert.equal(h.lastStatus(), "Pursuing goal (6s)", "resume excludes the paused interval");
  await h.tool("update_goal", { status: "complete" });
  await h.fire("agent_end", { messages: [{ role: "assistant", usage: { totalTokens: 7 } }] }, h.ctx);
  goal = (await h.tool("get_goal", {})).details.goal;
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
  await h.tool("create_goal", { objective: "old goal" });
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 2);
  await h.command("clear");
  await h.tool("create_goal", { objective: "new goal", token_budget: 20 });
  const messages = [{ role: "assistant", stopReason: "stop", usage: { input: 15, cacheRead: 10, output: 15 } }];
  await h.fire("agent_end", { messages }, h.ctx);
  assert.equal((await h.tool("get_goal", {})).details.goal.tokensUsed, 0);
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 3);
  await h.fire("agent_end", { messages }, h.ctx);
  const result = (await h.tool("get_goal", {})).details;
  assert.equal(result.goal.tokensUsed, 20);
  assert.equal(result.goal.timeUsedSeconds, 3);
  assert.equal(result.goal.status, "budgetLimited");
  assert.equal(result.remainingTokens, 0);
  assert.equal(h.entries.at(-1)?.data.action, "account");
  const sent = h.sent.length;
  tick(t, 2);
  assert.equal(h.sent.length, sent, "a budget-limited goal does not continue");
});

test("errors stop continuation and context keeps only the current goal's last continuation", async (t) => {
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
  assert.equal((await h.tool("get_goal", {})).details.goal.status, "usageLimited");
  assert.deepEqual((await h.fire("context", { messages: [first, user, last] })).messages, [user]);
});
