// codex-todo extension wiring — fake pi host. The panel's lifecycle hangs on
// exactly two host signals, and both were wrong or missing at some point:
//   - `session_start` opens the store and attaches the widget;
//   - `input` (a prompt submitted while idle) advances the turn ordinal, which
//     is what folds completed rows away and hides a finished panel.
// 0.19.4 replaced `ui_prompt_start` here: that is pi's blocking-DIALOG event
// (`ctx.ui.select/confirm/input`), so chat input never advanced the ordinal and
// old ✓ rows stayed on screen forever.
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { join } from "node:path";
import codexTodoExtension from "../../extensions/todo.ts";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";
import { todoState } from "../helpers/todo.mts";

function startHost(t: TestContext) {
  const dir = temporaryDirectory(t, "codex-todo-ext-");
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
  const widgets: unknown[] = [];
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notifications: string[] = [];
  const ctx = {
    cwd: dir,
    ui: {
      setWidget: (_key: string, content: unknown) => widgets.push(content),
      notify: (text: string) => notifications.push(text),
    },
    sessionManager: { getSessionId: () => "sess-ext" },
  };
  codexTodoExtension({
    on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    appendEntry() {},
  } as never);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  assert.deepEqual(tools.map((tool) => tool.name), ["todo"], "entry registers exactly one shipped tool");
  assert.deepEqual([...commands.keys()], ["todos", "todos-doctor"]);
  assert.ok(handlers.has("session_start"), "entry listens for session_start");
  assert.ok(handlers.has("input"), "chat input is the fold's turn signal");
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  const storeDir = join(dir, ".pi", "codex-todos");
  assert.ok(existsSync(storeDir), "entry opens the store in cwd");
  const call = async (params: unknown) => {
    const result = await tools[0].execute("call", params, undefined, undefined, ctx as never);
    const content = result.content[0];
    assert.ok(content.type === "text", "the registered tool returns text");
    return content.text;
  };
  return { call, ctx, handlers, commands, notifications, storeDir, panel: () => widgets.at(-1) };
}

test("input and steer fold a finished panel after its completion turn", async (t) => {
  const { call, ctx, handlers, notifications, panel } = startHost(t);
  assert.equal(panel(), undefined, "no panel while the store is empty");
  for (const [title, input] of [
    ["wired task", { text: "next" }],
    ["steered task", { text: "steer", streamingBehavior: "steer" }],
  ] as const) {
    const added = await call({ action: "add", tasks: [{ title }] });
    if (input.text === "steer") assert.match(added, /new list: 1 finished task\(s\) cleared/, "the previous list is history");
    assert.equal(typeof panel(), "function", `${input.text}: adding work registers the panel`);
    await call({ action: "complete", id: 1, evidence: "done here" });
    assert.equal(typeof panel(), "function", `${input.text}: completion stays visible in its own turn`);
    handlers.get("input")!({ type: "input", source: "interactive", ...input }, ctx);
    assert.equal(panel(), undefined, `${input.text}: the next user submission folds the finished list`);
  }
  assert.deepEqual(notifications, [], "the normal entry lifecycle reports no warning");
});

test("registered widget follows disk edits, persisted settings and session UI ownership", async (t) => {
  const { call, ctx, handlers, commands, notifications, storeDir, panel } = startHost(t);
  await call({ action: "add", tasks: [{ title: "before" }] });
  const factory = panel();
  assert.ok(typeof factory === "function", "the entry installed a widget factory");
  const component = factory({}, undefined);
  assert.match(component.render(80).join("\n"), /before/);
  writeFileSync(join(storeDir, TODO_STATE_FILE), JSON.stringify(todoState("after external edit")));
  assert.match(component.render(80).join("\n"), /after external edit/);
  component.handleMouse({ type: "press", button: "right" });
  assert.equal(panel(), undefined, "right press unregisters the real entry's widget");
  const reopened = openTodoStore(storeDir);
  t.after(() => reopened.dispose());
  assert.equal(reopened.settings().widgetHidden, true);
  await commands.get("todos")!.handler("", ctx as never);
  assert.equal(reopened.settings().widgetHidden, false);
  assert.equal(typeof panel(), "function", "/todos restores the registered widget");
  assert.match(notifications.at(-1)!, /after external edit/, "the actual command reads the external state");

  const nextPanels: unknown[] = [];
  const next = {
    ...ctx,
    ui: { ...ctx.ui, setWidget: (_key: string, content: unknown) => nextPanels.push(content) },
    sessionManager: { getSessionId: () => "replacement-session" },
  };
  handlers.get("session_start")!({ type: "session_start" }, next);
  assert.equal(panel(), undefined, "session replacement removes the old UI's panel");
  assert.equal(typeof nextPanels.at(-1), "function", "the replacement UI receives its own factory");
  assert.ok(handlers.has("session_shutdown"), "the entry owns shutdown cleanup");
  handlers.get("session_shutdown")!({ type: "session_shutdown" }, next);
  assert.equal(nextPanels.at(-1), undefined, "shutdown unregisters the active panel");
  const removed = nextPanels.length;
  handlers.get("session_shutdown")!({ type: "session_shutdown" }, next);
  assert.equal(nextPanels.length, removed, "repeated shutdown is inert");
  handlers.get("session_start")!({ type: "session_start" }, ctx);
  assert.equal(typeof panel(), "function", "a later session reopens the persisted task list");
});
