// codex-todo widget tests — pure rows, register-once contract, fold persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTodoStore } from "../src/todo/store.ts";
import { addTasks, claimTask, completeTask, skipTask, type TodoState } from "../src/todo/model.ts";
import { createTodoWidget, TODO_WIDGET_KEY, TODO_WIDGET_PLACEMENT } from "../src/todo/widget.ts";
import type { CodexTodoSystem } from "../src/todo/tools.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-widget-"));
  let turn = 5;
  const store = openTodoStore(dir);
  const system: CodexTodoSystem = { store, turn: () => turn, changed: () => {} };
  const widget = createTodoWidget({ system, sessionId: () => "sess-A" });
  const calls: { key: string; content: unknown; options?: unknown }[] = [];
  const fakeUi = {
    setWidget: (key: string, content: unknown, options?: unknown) => calls.push({ key, content, options }),
  };
  widget.attach(fakeUi);
  return { dir, store, system, widget, calls, turns: { set: (t: number) => { turn = t; }, get: () => turn } };
};

const stateWith = async (store: ReturnType<typeof openTodoStore>, items: { title: string; parentId?: number }[]) => {
  const r = await store.mutate((s) => addTasks(s, items, 1));
  if (!r.ok) throw new Error(r.error);
};

test("hidden when empty, register-once on first task, unregister when all done folds", async () => {
  const { dir, store, widget, calls, turns } = setup();
  try {
    widget.refresh();
    assert.equal(calls.length, 0); // nothing to show

    await stateWith(store, [{ title: "a" }, { title: "b" }]);
    widget.refresh();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, TODO_WIDGET_KEY);
    assert.equal((calls[0].options as { placement: string }).placement, TODO_WIDGET_PLACEMENT);

    // Second refresh with no change: no re-registration, no setWidget call.
    widget.refresh();
    assert.equal(calls.length, 1);

    // Complete both at the current turn → still visible (fresh completion).
    await store.mutate((s) => completeTask(s, 1, "ev1", Date.now(), turns.get()));
    await store.mutate((s) => completeTask(s, 2, "ev2", Date.now(), turns.get()));
    widget.refresh();
    assert.equal(calls.length, 1);

    // Next turn: completed rows fold away → widget unregisters.
    turns.set(6);
    widget.refresh();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].content, undefined); // setWidget(key, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows: header, tree indent, claims, blocked glyph, id prefix only with edges", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "root" }, { title: "child", parentId: 1 }, { title: "solo" }]);
    await store.mutate((s) => claimTask(s, 2, "sess-A", 3));
    const rows = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(rows[0], /Todos 0\/3 done/);
    assert.match(rows[1], /○ root/);
    assert.match(rows[2], /◐ child · mine/);
    assert.match(rows[3], /○ solo/);
    assert.ok(rows[rows.length - 1] === ""); // trailing spacer
    // No blockedBy edges → no #id noise.
    assert.ok(!rows.slice(1, -1).some((l) => l.includes("#")));

    await store.mutate((s) => {
      const t = s.tasks.find((x) => x.id === 3)!;
      return { ok: true as const, state: { ...s, tasks: s.tasks.map((x) => (x.id === 3 ? { ...t, blockedBy: [1] } : x)) }, value: t };
    });
    const rows2 = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(rows2[3], /⚠︎ #3 solo/); // edge exists → ids appear
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overflow: completed dropped first, +N more summary row, budget honored", async () => {
  const { dir, store, widget, turns } = setup();
  try {
    await stateWith(store, [
      { title: "live1" }, { title: "live2" }, { title: "live3" }, { title: "live4" }, { title: "live5" },
    ]);
    // Complete live4+live5 at turn 5 (current) so they are visible-but-completed.
    for (const id of [4, 5]) await store.mutate((s) => completeTask(s, id, "ev", Date.now(), turns.get()));
    // maxLines default 4 → header + 3 body rows + summary, spacer squeezed out.
    const rows = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(rows[0], /Todos 2\/5 done/);
    const summaryIdx = rows.findIndex((r) => r.startsWith("+"));
    assert.ok(summaryIdx > 0, "expected a +N more row");
    assert.match(rows[summaryIdx], /\+\d+ more \(\d+ completed, \d+ pending\)/);
    // live tasks survive, completed rows are the ones dropped.
    const body = rows.slice(1, summaryIdx);
    assert.ok(body.some((r) => r.includes("live1")));
    assert.ok(!body.some((r) => r.includes("✓")));
    assert.ok(rows.length <= 5); // header + budget body + summary (+ maybe spacer)
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fold: header only, persists to settings, restores on next open", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "a" }]);
    assert.equal(widget.isFolded(), false);
    widget.toggleFold();
    assert.equal(widget.isFolded(), true);
    const rows = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.equal(rows.length, 1);
    assert.match(rows[0], /Todos 0\/1 done ▸/);
    assert.equal(store.settings().widgetFolded, true);

    // Simulate /reload: a fresh widget over the same store starts folded.
    const system2: CodexTodoSystem = { store, turn: () => 5, changed: () => {} };
    const widget2 = createTodoWidget({ system: system2, sessionId: () => "s" });
    assert.equal(widget2.isFolded(), true);
    widget2.toggleFold();
    assert.equal(widget2.isFolded(), false);
    assert.equal(store.settings().widgetFolded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factory is a getter closure: render reflects the latest store state", async () => {
  const { dir, store, widget, calls } = setup();
  try {
    await stateWith(store, [{ title: "first" }]);
    widget.refresh();
    const content = calls[0].content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
    assert.equal(typeof content, "function");
    const lines1 = content({ requestRender() {} }, undefined).render(80);
    assert.ok(lines1.some((l) => l.includes("first")));

    await store.mutate((s) => addTasks(s, [{ title: "second" }], 2));
    // No re-registration; the same factory now renders the new task.
    assert.equal(calls.length, 1);
    const lines2 = content({ requestRender() {} }, undefined).render(80);
    assert.ok(lines2.some((l) => l.includes("second")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("width truncation keeps lines within budget", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "x".repeat(200) }]);
    const rows = widget.buildRows(store.read(), 40, 5);
    for (const r of rows) {
      if (r.text) assert.ok([...r.text].length <= 40, `line longer than 40: ${r.text.length}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skipped tasks count as done in the header", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "a" }, { title: "b" }]);
    
    await store.mutate((s) => skipTask(s, 1, "wont do", 3));
    const rows = widget.buildRows(store.read(), 80, 5);
    assert.match(rows[0].text, /Todos 1\/2 done/);
    assert.equal(rows[0].tone, "accent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
