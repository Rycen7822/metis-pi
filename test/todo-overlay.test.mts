// codex-todo overlay tests — fake ui.custom host, tmpdir store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTodoStore } from "../src/todo/store.ts";
import { addTasks } from "../src/todo/model.ts";
import { buildOverlayRows, openTodoOverlay, type TodoOverlayKeybindings } from "../src/todo/overlay.ts";
import type { CodexTodoSystem } from "../src/todo/tools.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

const kb = (named: Record<string, boolean>): TodoOverlayKeybindings => ({
  matches: (data, name) => named[`${data}:${name}`] === true,
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-overlay-"));
  const store = openTodoStore(dir);
  const system: CodexTodoSystem = { store, turn: () => 5, changed: () => {} };
  return { dir, store, system };
};

test("rows: header, ids always visible, tree indent, help footer, empty hint", async () => {
  const { dir, store, system } = setup();
  try {
    const empty = buildOverlayRows(store.read(), "s", 0, 60);
    assert.match(empty[1].text, /no tasks/);
    await store.mutate((s) => addTasks(s, [{ title: "root" }, { title: "child", parentId: 1 }], 1));
    const rows = buildOverlayRows(store.read(), "s", 0, 60); // cursor on first task row
    assert.match(rows[0].text, /codex-todo \(2 tasks\)/);
    assert.match(rows[1].text, /❯ ○ #1 root/); // cursor row
    assert.match(rows[2].text, /○ #2 child/); // no cursor mark
    assert.ok(rows[2].text.startsWith("    ○")); // mark+space+depth indent
    assert.match(rows[rows.length - 1].text, /space progress/);
    void system;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openTodoOverlay: custom() invoked with overlay options; keys drive mutations", async () => {
  const { dir, store, system } = setup();
  try {
    await store.mutate((s) => addTasks(s, [{ title: "a" }, { title: "b" }], 1));
    let captured: {
      factory: (tui: unknown, theme: unknown, keybindings: TodoOverlayKeybindings, done: (r: string) => void) => { render(w: number): string[]; handleInput?(d: string): void };
      options?: { overlay?: boolean; overlayOptions?: unknown };
    } | undefined;
    let resolved: string | null = null;
    const fakeUi = {
      custom: (factory: never, options?: never) => {
        captured = { factory: factory as never, options };
        return Promise.resolve("closed" as string).then((r) => { resolved = r; return r; });
      },
    };
    const p = openTodoOverlay(fakeUi, { system, sessionId: () => "sess-A" });
    assert.ok(captured);
    assert.equal(captured.options.overlay, true);
    assert.deepEqual(captured.options.overlayOptions, { width: "80%", maxHeight: "80%", anchor: "center" });

    const component = captured.factory({ requestRender() {} }, undefined, kb({
      "\x1b[B:tui.select.down": true,
      "\x1b[A:tui.select.up": true,
    }), () => {});
    const lines0 = component.render(60);
    assert.ok(lines0.some((l) => l.includes("❯ ○ #1 a")));

    component.handleInput?.("\x1b[B"); // down → cursor on #2
    const lines1 = component.render(60);
    assert.ok(lines1.some((l) => l.includes("❯ ○ #2 b")));

    component.handleInput?.(" "); // pending → in_progress
    await tick();
    let state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 2)!.status, "in_progress");

    component.handleInput?.(" "); // in_progress → complete (overlay evidence)
    await tick();
    state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 2)!.status, "complete");
    assert.match(state.tasks.find((t) => t.id === 2)!.evidence!, /overlay/);

    component.handleInput?.("\x1b[A"); // up → cursor on #1
    component.handleInput?.("x"); // claim #1 for sess-A
    await tick();
    state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 1)!.claim?.session, "sess-A");

    component.handleInput?.("x"); // release (mine)
    await tick();
    state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 1)!.claim, null);

    component.handleInput?.("s"); // skip #1 (pending → skipped)
    await tick();
    state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 1)!.status, "skipped");

    component.handleInput?.("\x1b"); // Esc closes
    await p;
    assert.equal(resolved, "closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlay mutations flash errors instead of crashing", async () => {
  const { dir, store, system } = setup();
  try {
    await store.mutate((s) => addTasks(s, [{ title: "parent" }, { title: "child", parentId: 1 }], 1));
    let captured: { factory: (tui: unknown, theme: unknown, kb: TodoOverlayKeybindings, done: (r: string) => void) => { render(w: number): string[]; handleInput?(d: string): void } } | undefined;
    const fakeUi = { custom: (f: never) => { captured = { factory: f as never }; return Promise.resolve("closed").then(() => undefined); } };
    const p = openTodoOverlay(fakeUi, { system, sessionId: () => "s" });
    const component = captured!.factory({}, undefined, kb({}), () => {});
    component.handleInput?.(" "); // start parent (pending → in_progress)
    await tick();
    component.handleInput?.(" "); // try complete parent with open child → gate flashes
    await tick();
    const lines = component.render(80);
    assert.ok(lines.some((l) => l.includes("unfinished subtasks")));
    const state = store.read();
    assert.equal(state.tasks.find((t) => t.id === 1)!.status, "in_progress"); // unchanged
    component.handleInput?.("\x1b");
    await p;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
