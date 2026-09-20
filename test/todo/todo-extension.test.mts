// codex-todo extension wiring — fake pi host. The panel's lifecycle hangs on
// exactly two host signals, and both were wrong or missing at some point:
//   - `session_start` opens the store and attaches the widget;
//   - `input` (a prompt submitted while idle) advances the turn ordinal, which
//     is what folds completed rows away and hides a finished panel.
// 0.19.4 replaced `ui_prompt_start` here: that is pi's blocking-DIALOG event
// (`ctx.ui.select/confirm/input`), so chat input never advanced the ordinal and
// old ✓ rows stayed on screen forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codexTodoExtension from "../../extensions/todo.ts";

interface FakeHost {
  handlers: Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>;
  setWidget: (key: string, content: unknown) => void;
  widgets: unknown[];
  tool: { execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }> };
  notify: string[];
}

const startHost = (dir: string): FakeHost => {
  const host: Partial<FakeHost> = {};
  host.handlers = new Map();
  host.widgets = [];
  host.notify = [];
  const setWidget = (_key: string, content: unknown) => { host.widgets!.push(content); };
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) => { host.handlers!.set(name, handler); },
    registerTool: (def: FakeHost["tool"]) => { host.tool = def; },
    registerCommand: () => {},
    appendEntry: () => {},
  };
  const ctx = {
    cwd: dir,
    ui: { setWidget, notify: (text: string) => { host.notify!.push(text); } },
    sessionManager: { getSessionId: () => "sess-ext" },
  };
  codexTodoExtension(pi as never);
  assert.ok(host.handlers!.has("session_start"), "the extension listens for session_start");
  assert.ok(host.handlers!.has("input"), "the extension listens for input (the fold's turn signal)");
  host.handlers!.get("session_start")!({ type: "session_start" }, ctx);
  host.setWidget = (key, content) => setWidget(key, content);
  return host as FakeHost;
};

const lastWidget = (host: FakeHost): unknown => host.widgets[host.widgets.length - 1];

test("a user prompt folds completed rows and hides the finished panel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-ext-"));
  try {
    const host = startHost(dir);
    const ctx = { cwd: dir, ui: { setWidget: host.setWidget, notify: () => {} }, sessionManager: { getSessionId: () => "sess-ext" } };
    const call = (params: unknown) => host.tool.execute("call", params, undefined, undefined, ctx);

    // The widget only registers itself once there is work to show.
    assert.equal(lastWidget(host), undefined, "no panel while the store is empty");
    await call({ action: "add", tasks: [{ title: "wired task" }] });
    assert.ok(typeof lastWidget(host) === "function", "adding work registers the panel");

    // Completing the only task keeps the ✓ row for the rest of this turn …
    await call({ action: "complete", id: 1, evidence: "done here" });
    assert.ok(typeof lastWidget(host) === "function", "the panel survives the turn that completed it");

    // … and the NEXT prompt folds it away: the ordinal advances only on the
    // host's `input` event, and a fully done list unregisters entirely.
    host.handlers.get("input")!({ type: "input", text: "next", source: "interactive" }, ctx);
    assert.equal(lastWidget(host), undefined, "the finished panel folds away on the next prompt");

    // A steer — the user typing while the agent still works, which is what the
    // pty harness produces — is a user message too, so it folds as well.
    const steered = await call({ action: "add", tasks: [{ title: "steered task" }] });
    assert.match(steered.content[0].text, /new list: 1 finished task\(s\) cleared/, "the first ✓ list was already history");
    await call({ action: "complete", id: 1, evidence: "done too" });
    assert.ok(typeof lastWidget(host) === "function", "the new list shows its ✓ row");
    host.handlers.get("input")!({ type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
    assert.equal(lastWidget(host), undefined, "a steer folds too (it is user input)");

    // A finished list is history: new work starts a NEW list rather than
    // appending to it (0.19.4).
    const added = await call({ action: "add", tasks: [{ title: "fresh work" }] });
    assert.match(added.content[0].text, /#1 fresh work \(new list: 1 finished task\(s\) cleared; ids restart at #1/);
    const listed = await call({ action: "list" });
    assert.match(listed.content[0].text, /Todos: 0\/1 done/);
    assert.doesNotMatch(listed.content[0].text, /wired task|steered task/, "no history is carried over");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
