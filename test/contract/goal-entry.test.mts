import { validateToolArguments } from "@earendil-works/pi-ai";
import { createEventBus, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { setImmediate as nextTurn } from "node:timers/promises";
import { altScreen, container, screenLines } from "../helpers/ui-fixtures.mjs";
import { sgr } from "../helpers.mjs";
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
  const notifications: string[] = [];

  const pi = {
    events: createEventBus(),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
    registerTool: (definition: { name: string }) => tools.set(definition.name, definition),
    sendMessage: (message: unknown) => sent.push(message),
  };

  const ctx = {
    mode: "rpc" as "rpc" | "tui",
    hasUI: true,
    sessionManager: { getBranch: (): Array<{ type: string; customType?: string; data?: unknown }> => [], getSessionId: () => "goal-test-session" },
    hasPendingMessages: () => false,
    isIdle: () => true,
    ui: {
      theme: { fg: (_key: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
      notify: (message: string) => { notifications.push(message); },
      confirm: async () => false,
      editor: async (): Promise<string | undefined> => undefined,
      custom: async (..._args: any[]): Promise<any> => undefined,
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
    notifications,
    command: async (args: string) => await commands.get("goal")!.handler(args, ctx),
    tools,
    tool: async (action: string, params: Record<string, unknown> = {}) =>
      await tools.get("goal")!.execute(`call-${action}`, { action, ...params }, undefined, undefined, ctx),
    fire: async (event: string, ...args: unknown[]) => await handlers.get(event)!(...args),
    lastStatus: () => statusCalls.at(-1)?.text,
  };
}

function popupHost(h: ReturnType<typeof makeHost>) {
  initTheme("dark", false);
  const { tui: native, terminal } = altScreen(100, 40);
  const tui = native as any; // Same native input/render driver used by the JS UI contract tests.
  Object.assign(terminal, {
    hideCursor: () => terminal.write("\u001b[?25l"), showCursor: () => terminal.write("\u001b[?25h"),
  });
  const composer = new Input();
  composer.setValue("keep the main input");
  tui.setLayoutRoot(container(composer));
  tui.setFocus(composer);
  h.ctx.mode = "tui";
  const host = { ui: tui, editor: { getText: () => composer.getValue() }, keybindings: new KeybindingsManager(TUI_KEYBINDINGS) };
  // Use the SDK's real overlay completion/disposal path, not a second UI lifecycle.
  const show = (InteractiveMode.prototype as any).showExtensionCustom.bind(host);
  let popup: Component | undefined;
  h.ctx.ui.custom = (factory, options) => show((...args: any[]) => popup = factory(...args), options);
  const frame = () => { tui.doRender(); return screenLines(tui); };
  const key = (data: string) => { tui.handleTerminalInput(data); return frame().join("\n"); };
  const click = (label: string, before?: () => void) => {
    const lines = frame(), y = lines.findIndex((line: string) => line.includes(label));
    assert.ok(y >= 0, `popup contains ${label}`);
    const x = visibleWidth(lines[y].slice(0, lines[y].indexOf(label))) + 1;
    before?.();
    tui.handleTerminalInput(sgr(0, x, y + 1));
    tui.handleTerminalInput(sgr(0, x, y + 1, true));
    return frame().join("\n");
  };
  const ready = async () => {
    const deadline = performance.now() + 2000;
    while (!tui.hasOverlay() && performance.now() < deadline) await nextTurn();
    assert.ok(tui.hasOverlay(), `goal opens a real native overlay; ${h.notifications.join("; ")}`);
    return frame().join("\n");
  };
  return { tui, terminal, composer, frame, key, click, ready, get popup() { assert.ok(popup); return popup; } };
}

/** Mock timers tick in whole steps, so each second is one scheduler advance. */
function tick(t: TestContext, seconds: number): void {
  for (let i = 0; i < seconds; i += 1) t.mock.timers.tick(1000);
}

test("goal popup keeps live usage, edits through native input and leaves Cancel and close read-only", async t => {
  const h = makeHost(t), ui = popupHost(h);
  await h.tool("create", { objective: "\u001b]52;c;Y2xpcGJvYXJk\u0007original objective", token_budget: 100 });
  tick(t, 3);
  const original = (await h.tool("get")).details.goal;
  const entries = h.entries.length, sent = h.sent.length;
  const custom = t.mock.method(h.ctx.ui, "custom");
  h.events.emit("metis:goal-open", {});
  h.events.emit("metis:goal-open", {});
  assert.match(await ui.ready(), /Pursuing · Elapsed: 3s/);
  assert.equal(custom.mock.calls.length, 1, "repeated clicks keep one popup");
  const box = ui.popup.render(90).map(stripTerminalSequences);
  assert.equal(box.length, 28, "short goals keep the subagent viewer's 70% height");
  assert.equal(box[0], `╭${"─".repeat(88)}╮`);
  assert.equal(box.at(-1), `╰${"─".repeat(88)}╯`);
  assert.ok(box.every(row => visibleWidth(row) === 90), "the full frame uses the subagent viewer's 90% width");
  assert.equal(ui.frame()[6].slice(5), box[0], "the native overlay centers the full frame");
  assert.equal(ui.frame()[33].slice(5), box.at(-1));
  ui.key("readonly text must not edit");
  ui.click("[Edit]");
  assert.match(ui.click("[Editing]"), /\[Cancel\].*\[Save\]/);
  assert.doesNotMatch(ui.popup.render(90).join("\n"), /\u001b\]52;/, "goal data cannot inject terminal controls through Editor prefill");
  ui.key("draft to discard");
  assert.match(ui.click("[Save]", () => ui.tui.handleTerminalInput("\u001b")), /original objective/);
  ui.click("[Edit]");
  ui.key("another cancelled draft");
  ui.click("[Cancel]");
  assert.equal(h.entries.length, entries);
  assert.equal(h.sent.length, sent, "viewing and cancelling never queue a model turn");
  ui.click("[Edit]");
  assert.ok(ui.popup.render(90).some(line => line.includes(CURSOR_MARKER)), "editing forwards focus for the IME cursor");
  ui.click("original objective");
  assert.ok(ui.tui.isOverlayFocused(), "clicking Editor does not steal the popup's Escape/Save keys");
  ui.key("\u001b[F");
  ui.key("\u0015");
  ui.key("新的目标👩‍🔬");
  ui.key("\r");
  const pasted = Array.from({ length: 12 }, (_, i) => `step ${i}`).join("\n");
  ui.key(`\u001b[200~${pasted}\u001b[201~`);
  ui.click("[Save]");
  const saved = (await h.tool("get")).details.goal;
  assert.equal(saved.objective, `新的目标👩‍🔬\n${pasted}`, "Save expands native paste markers and preserves newlines");
  for (const field of ["threadId", "createdAt", "tokensUsed", "tokenBudget", "status"]) assert.equal(saved[field], original[field], field);
  assert.equal(saved.timeUsedSeconds, 3, "editing accounts elapsed time without resetting it");
  assert.equal(h.entries.at(-1)?.data.action, "edit");
  ui.terminal.rows = 12;
  assert.match(ui.click("[Edit]"), /\[Editing\].*\[Cancel\].*\[Save\]/);
  assert.ok(ui.popup.render(90).some(line => line.includes(CURSOR_MARKER)), "resize keeps the editor cursor, not just the toolbar");
  for (const width of [1, 4, 12, 90]) {
    const rows = ui.popup.render(width);
    assert.ok(rows.length <= 8 && rows.every(row => visibleWidth(row) <= width), "narrow overlays stay inside their viewport");
  }
  ui.click("step 10");
  ui.key("X");
  ui.click("[Save]");
  assert.equal((await h.tool("get")).details.goal.objective, `新的目标👩‍🔬\n${pasted.replace("step 10", "Xstep 10")}`,
    "clicking cropped editor content edits the displayed logical line");
  assert.match(ui.key("\u001b[F"), /step 11/, "readonly End scrolls to the last goal line");
  assert.doesNotMatch(ui.key("\u001b[H"), /step 11/, "readonly Home returns to the start");
  ui.terminal.rows = 40;
  tick(t, 2);
  assert.match(ui.frame().join("\n"), /Elapsed: 5s/);
  await h.tool("update", { status: "blocked" });
  assert.match(ui.frame().join("\n"), /Blocked/);
  tick(t, 2);
  assert.match(ui.frame().join("\n"), /Elapsed: 5s/, "blocked time is not counted");
  await h.tool("update", { status: "complete" });
  assert.match(ui.frame().join("\n"), /Completed/);
  ui.click("[X]");
  assert.equal(ui.tui.hasOverlay(), false);
  await nextTurn();
  h.events.emit("metis:goal-open", {});
  assert.match(await ui.ready(), /Completed · Elapsed: 5s/, "stopping the clock must retain the goal UI context");
  ui.click("[X]");
  assert.equal(ui.composer.focused, true);
  assert.equal(ui.composer.getValue(), "keep the main input");
});

test("goal popup pauses and resumes with command accounting and continuation semantics", async t => {
  const h = makeHost(t), ui = popupHost(h);
  await h.tool("create", { objective: "pause from the popup", token_budget: 100 });
  await h.fire("agent_start", {}, h.ctx);
  tick(t, 3);
  h.events.emit("metis:goal-open", {});
  await ui.ready();
  const before = (await h.tool("get")).details.goal;
  const continuations = () => h.sent.filter((message: any) => message.customType === "goal-continuation").length;
  const queued = continuations();
  assert.match(ui.click("[Pause]"), /Paused · Elapsed: 3s/);
  assert.match(h.lastStatus()!, /Goal paused/);
  tick(t, 5);
  await h.fire("agent_end", { messages: [] }, h.ctx);
  const paused = (await h.tool("get")).details.goal;
  assert.equal(paused.status, "paused");
  assert.equal(paused.timeUsedSeconds, 3, "pausing stops the goal clock without resetting usage");
  for (const field of ["threadId", "objective", "createdAt", "tokensUsed", "tokenBudget"]) assert.equal(paused[field], before[field]);
  assert.equal(continuations(), queued, "a paused turn cannot queue a continuation");
  assert.match(ui.click("[Resume]"), /Pursuing · Elapsed: 3s/);
  assert.equal(continuations(), queued + 1, "explicit resume queues exactly one continuation");
  tick(t, 2);
  assert.match(ui.key("\u0010"), /Paused · Elapsed: 5s/, "Ctrl+P is the keyboard path to the pause control");
  assert.equal((await h.tool("get")).details.goal.status, "paused");
  assert.equal(h.entries.at(-1)?.data.action, "status");
  ui.click("[X]");
  assert.equal(ui.composer.focused, true);
});

test("long goals expose a right-edge scrollbar through native keys, wheel, drag and resize", async t => {
  const h = makeHost(t), ui = popupHost(h);
  await h.tool("create", { objective: Array.from({ length: 100 }, (_, i) => `目标 ${i} · 👩‍🔬`).join("\n") });
  h.events.emit("metis:goal-open", {});
  await ui.ready();
  const rows = () => ui.popup.render(90).map(stripTerminalSequences);
  const thumb = () => rows().flatMap((row, i) => row.endsWith("┃") ? [i] : []);
  const initial = thumb();
  assert.ok(initial.length > 0, "overflow paints a visible thumb on the right frame");
  assert.match(ui.key("\u001b[F"), /目标 99/);
  assert.equal(thumb().at(-1), rows().length - 3, "End puts the thumb at the bottom of the body");
  assert.doesNotMatch(ui.key("\u001b[H"), /目标 99/);
  assert.equal(thumb()[0], initial[0], "Home returns the thumb to the first body row");
  const frame = ui.frame();
  const top = frame.findIndex((row: string) => row.includes("╭"));
  const left = frame[top].indexOf("╭");
  const edge = left + 89, firstBody = top + initial[0], lastBody = top + rows().length - 3;
  ui.tui.handleTerminalInput(sgr(65, left + 4, firstBody + 1));
  assert.match(ui.frame()[firstBody], /目标 1 ·/, "native wheel events scroll the goal rather than the background");
  ui.tui.handleTerminalInput(sgr(0, edge + 1, lastBody + 1));
  ui.tui.handleTerminalInput(sgr(0, edge + 1, lastBody + 1, true));
  assert.match(ui.frame().join("\n"), /目标 99/, "clicking the lower track reaches the tail");
  ui.tui.handleTerminalInput(sgr(0, edge + 1, firstBody + 1));
  ui.frame();
  ui.tui.handleTerminalInput(sgr(32, 2, 40));
  ui.tui.handleTerminalInput(sgr(0, 2, 40, true));
  assert.match(ui.frame().join("\n"), /目标 99/, "captured scrollbar drags clamp outside the popup");
  ui.terminal.rows = 60;
  ui.frame();
  assert.equal(rows().length, 42);
  assert.equal(thumb().at(-1), rows().length - 3, "a larger viewport clamps the reading position to the new maximum");
  h.ctx.ui.editor = async () => "short goal";
  await h.command("edit");
  assert.deepEqual(thumb(), [], "short text removes the scrollbar without shrinking the frame");
  assert.equal(rows().length, 42);
  ui.click("[X]");
});

test("goal popup retains invalid and conflicting drafts and closes across branch changes and shutdown", async t => {
  const h = makeHost(t), ui = popupHost(h);
  await h.command("original");
  const opened = h.command("");
  await ui.ready();
  ui.click("[Edit]");
  ui.key("\u0015");
  assert.match(ui.click("[Save]"), /must not be empty/);
  assert.equal((await h.tool("get")).details.goal.objective, "original");
  ui.key("x".repeat(4001));
  assert.match(ui.click("[Save]"), /too long/);
  assert.equal((await h.tool("get")).details.goal.objective, "original");
  ui.key("\u0015");
  ui.key("local draft");
  h.ctx.ui.editor = async () => "external edit";
  await h.command("edit");
  assert.match(ui.click("[Save]"), /changed while editing/);
  assert.equal((await h.tool("get")).details.goal.objective, "external edit");
  ui.click("[Cancel]");
  ui.click("[Edit]");
  ui.key("will not save on navigation");
  const branch = structuredClone(h.entries.at(-1)!.data);
  h.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "goal", data: branch }];
  await h.fire("session_tree", {}, h.ctx);
  await opened;
  assert.equal(ui.tui.hasOverlay(), false);
  assert.equal((await h.tool("get")).details.goal.objective, "external edit");
  h.events.emit("metis:goal-open", {});
  await ui.ready();
  ui.click("[Edit]");
  ui.key("another unsaved draft");
  await h.fire("session_shutdown", {}, h.ctx);
  assert.equal(ui.tui.hasOverlay(), false);
  assert.deepEqual(ui.popup.render(90), [], "disposed views cannot retain input targets");
});

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
  const systemPromptOptions = { sections: {} as Record<string, string> };
  await h.fire("before_agent_start", { systemPrompt: "BASE", systemPromptOptions }, h.ctx);
  const prompt = systemPromptOptions.sections.metis_goal;
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
