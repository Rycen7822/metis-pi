// goal.test.mts — the vendored goal extension (goal.ts).
// Upstream recomputes the footer status only at goal lifecycle events, so a goal
// running inside one long agent run stayed frozen at "Pursuing goal (0s)" until a
// state transition. metis-pi's patch adds a 1s refresh (syncStatusTimer). These
// cases drive the real extension against a stub Pi host under Node mock timers and
// pin the refresh, its stop conditions, and that reading the snapshot every second
// never double-counts elapsed time.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import goalExtension from "../../extensions/goal.ts";

const NOW = 1_700_000_000_000;

function makeHost() {
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

  return {
    ctx,
    statusCalls,
    entries,
    sent,
    commands,
    tools,
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

test("the packaged entry registers the /goal command and the goal tools", () => {
  const h = makeHost();
  assert.equal(typeof h.commands.get("goal")?.handler, "function");
  assert.deepEqual([...h.tools.keys()].sort(), ["create_goal", "get_goal", "update_goal"]);
});

test("footer elapsed refreshes once per second while the goal is active", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
  await h.fire("session_start", {}, h.ctx);

  await h.command("ship the ticking clock");
  assert.equal(h.lastStatus(), "Pursuing goal (0s)");

  tick(t, 1);
  assert.equal(h.lastStatus(), "Pursuing goal (1s)");
  tick(t, 2);
  assert.deepEqual(h.statusCalls.slice(-2).map((call) => call.text), [
    "Pursuing goal (2s)",
    "Pursuing goal (3s)",
  ]);
});

test("shutdown stops the active refresh and reload only refreshes the new context", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const previous = makeHost();
  await previous.command("survive a reload without retaining its UI");
  tick(t, 1);
  const saved = structuredClone(previous.entries.at(-1)!.data);
  await previous.fire("session_shutdown", {}, previous.ctx);
  await previous.fire("session_shutdown", {}, previous.ctx);
  const stopped = previous.statusCalls.length;

  const reloaded = makeHost();
  reloaded.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: saved }];
  await reloaded.fire("session_start", {}, reloaded.ctx);
  const started = reloaded.statusCalls.length;
  tick(t, 3);
  assert.equal(previous.statusCalls.length, stopped, "the disposed extension must not refresh its old UI");
  assert.equal(reloaded.statusCalls.length, started + 3, "exactly one timer refreshes the replacement UI");
  await reloaded.fire("session_shutdown", {}, reloaded.ctx);
  const finished = reloaded.statusCalls.length;
  tick(t, 2);
  assert.equal(reloaded.statusCalls.length, finished);
});

test("pause, resume and completion control the refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
  await h.fire("session_start", {}, h.ctx);
  await h.command("ship the ticking clock");
  tick(t, 2);

  await h.command("pause");
  assert.equal(h.lastStatus(), "Goal paused (/goal resume)");
  const paused = h.statusCalls.length;
  tick(t, 5);
  assert.equal(h.statusCalls.length, paused, "a paused goal must not refresh the footer");

  await h.command("resume");
  tick(t, 1);
  assert.equal(h.lastStatus(), "Pursuing goal (3s)", "elapsed continues from the paused value");

  await h.tool("update_goal", { status: "complete" });
  assert.equal(h.lastStatus(), "Goal complete");
  const complete = h.statusCalls.length;
  tick(t, 5);
  assert.equal(h.statusCalls.length, complete, "a completed goal must not refresh the footer");
});

test("the 1s refresh never double-counts elapsed time", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
  await h.fire("session_start", {}, h.ctx);
  await h.tool("create_goal", { objective: "count the elapsed seconds once" });
  await h.fire("agent_start", {}, h.ctx);

  tick(t, 3);
  await h.fire("agent_end", { messages: [] }, h.ctx);

  const accounts = h.entries.filter((entry) => entry.type === "goal" && entry.data.action === "account");
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].data.goal.timeUsedSeconds, 3);
});

test("turn accounting stays with the goal that started the turn and stops at its budget", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
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

test("branch restore, paused edits and completion preserve usage and elapsed-time boundaries", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
  await h.tool("create_goal", { objective: "persist me", token_budget: 100 });
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 2);
  await h.command("pause");
  const saved = structuredClone(h.entries.at(-1)!.data);
  h.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: saved }];
  await h.fire("session_tree", {}, h.ctx);
  h.ctx.ui.editor = async () => "edited while paused";
  await h.command("edit");
  tick(t, 3);
  let goal = (await h.tool("get_goal", {})).details.goal;
  assert.equal(goal.status, "paused");
  assert.equal(goal.timeUsedSeconds, 2);
  assert.equal(goal.objective, "edited while paused");
  await h.command("resume");
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 1);
  await h.tool("update_goal", { status: "complete" });
  await h.fire("agent_end", { messages: [{ role: "assistant", usage: { totalTokens: 7 } }] }, h.ctx);
  goal = (await h.tool("get_goal", {})).details.goal;
  assert.equal(goal.status, "complete", "final accounting must not reopen a completed goal");
  assert.equal(goal.tokensUsed, 7);
  assert.equal(goal.timeUsedSeconds, 3);
});

test("errors stop continuation and context keeps only the current goal's last continuation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: NOW });
  const h = makeHost();
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
