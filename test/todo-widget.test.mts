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
    // maxLines default 5 → header + 3 body rows + summary = 5 lines (one row is
    // given up to the summary), plus the trailing spacer.
    const rows = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(rows[0], /Todos 2\/5 done/);
    const summaryIdx = rows.findIndex((r) => r.startsWith("+"));
    assert.ok(summaryIdx > 0, "expected a +N more row");
    assert.match(rows[summaryIdx], /\+\d+ more \(\d+ completed, \d+ pending\)/);
    assert.equal(summaryIdx, 4, "three task rows then the summary");
    // The pending rows survive; both completed rows are dropped first so the
    // whole three-row list stays actionable.
    const body = rows.slice(1, summaryIdx);
    assert.deepEqual(body.map((r) => r.slice(2, 7)), ["live1", "live2", "live3"]);
    assert.match(rows[summaryIdx], /\+2 more \(2 completed, 0 pending\)/);
    assert.ok(rows.length <= 6); // header + budget body + summary + spacer
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expanded shows the whole list with no summary, and persists to settings", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [
      { title: "one" }, { title: "two" }, { title: "three" }, { title: "four" }, { title: "five" }, { title: "six" },
    ]);
    const collapsed = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(collapsed[0], /Todos 0\/6 done ▾ · click to expand/);
    assert.ok(collapsed.some((r) => r.startsWith("+")), "collapsed hides the tail");

    assert.equal(widget.isExpanded(), false);
    widget.toggleExpanded();
    assert.equal(widget.isExpanded(), true);
    assert.equal(store.settings().widgetExpanded, true);
    const expanded = widget.buildRows(store.read(), 80, 5).map((r) => r.text);
    assert.match(expanded[0], /Todos 0\/6 done ▴ · click to collapse/);
    assert.ok(!expanded.some((r) => r.startsWith("+")), "expanded drops the summary");
    for (const t of ["one", "two", "three", "four", "five", "six"]) {
      assert.ok(expanded.some((r) => r.includes(t)), `${t} must be visible when expanded`);
    }

    // A fresh widget over the same store starts expanded (the view survives /reload).
    const widget2 = createTodoWidget({ system: { store, turn: () => 5, changed: () => {} }, sessionId: () => "s" });
    assert.equal(widget2.isExpanded(), true);
    widget2.toggleExpanded();
    assert.equal(store.settings().widgetExpanded, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a left click on the panel toggles the full list; other events pass through", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }, { title: "e" }]);
    const component = widget.component({ requestRender() {} });
    assert.equal(typeof component.handleMouse, "function");
    const collapsed = component.render(80);
    assert.equal(collapsed.length, 6); // header + 3 body + summary + spacer

    // Non-click events are ignored so the transcript keeps them. (A right
    // click HIDES the panel — covered by the hide test below. The right PRESS
    // is claimed so the host synthesizes the click: see the host-contract
    // comment in widget.ts.)
    assert.equal(component.handleMouse?.({ type: "wheel", button: "none", wheelDelta: 3 }), undefined);
    assert.equal(component.handleMouse?.({ type: "press", button: "left" }), undefined);
    assert.equal(component.handleMouse?.({ type: "click", button: "middle" }), undefined);
    assert.deepEqual(component.handleMouse?.({ type: "press", button: "right" }), { handled: true });

    const claimed = component.handleMouse?.({ type: "click", button: "left" });
    assert.deepEqual(claimed, { handled: true });
    assert.equal(widget.isExpanded(), true);
    const expanded = component.render(80);
    assert.equal(expanded.length, 7); // header + 5 tasks + spacer, no summary row
    assert.ok(expanded.some((l) => l.includes("click to collapse")));

    // Clicking again collapses back to the three-row list.
    component.handleMouse?.({ type: "click", button: "left" });
    assert.equal(widget.isExpanded(), false);
    const again = component.render(80);
    assert.equal(again.length, 6);
    assert.match(again[0], /click to expand/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a right click hides the panel; hide persists and /todos-style show restores it", async () => {
  const { dir, store, widget, calls } = setup();
  try {
    await stateWith(store, [{ title: "a" }, { title: "b" }]);
    widget.refresh();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].content != null, true);

    const component = widget.component({ requestRender() {} });
    const claimed = component.handleMouse?.({ type: "press", button: "right" });
    assert.deepEqual(claimed, { handled: true });
    const clicked = component.handleMouse?.({ type: "click", button: "right" });
    assert.deepEqual(clicked, { handled: true });
    assert.equal(widget.isHidden(), true);
    // Persisted so a restart keeps the panel away.
    assert.equal(store.settings().widgetHidden, true);
    // refresh() unregisters instead of re-rendering.
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, TODO_WIDGET_KEY);
    assert.equal(calls[1].content, undefined);

    // Store changes while hidden: still gone, no new registration.
    await stateWith(store, [{ title: "c" }]);
    widget.refresh();
    assert.equal(calls.length, 2);

    // Opening /todos calls show(): the panel comes back and stays back.
    widget.show();
    assert.equal(widget.isHidden(), false);
    assert.equal(store.settings().widgetHidden, false);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].content != null, true);
    await stateWith(store, [{ title: "d" }]);
    widget.refresh();
    assert.equal(calls.length, 3); // already registered, just a render
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hide state survives a fresh widget over the same store", async () => {
  const { dir, store, widget, calls } = setup();
  try {
    await stateWith(store, [{ title: "a" }]);
    widget.hide();
    assert.equal(store.settings().widgetHidden, true);

    // A new widget (restart) reads the persisted hide and refuses to show.
    const system2: CodexTodoSystem = { store, turn: () => 5, changed: () => {} };
    const widget2 = createTodoWidget({ system: system2, sessionId: () => "sess-A" });
    widget2.attach({ setWidget: (key: string, content: unknown) => calls.push({ key, content }) });
    assert.equal(widget2.isHidden(), true);
    widget2.refresh();
    assert.equal(calls.length, 0); // hidden → never registers

    widget2.show();
    widget2.refresh();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].content != null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live latch keeps the panel from shrinking under live updates", async () => {
  const { dir, store, widget, calls } = setup();
  try {
    await stateWith(store, [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }, { title: "e" }]);
    widget.refresh();
    const content = calls[0].content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
    const first = content({ requestRender() {} }, undefined).render(80);
    assert.equal(first.length, 6);

    // Two tasks complete and fold away next turn: the panel must not shrink.
    await store.mutate((s) => completeTask(s, 1, "ev", Date.now(), 5));
    await store.mutate((s) => completeTask(s, 2, "ev", Date.now(), 5));
    const padded = content({ requestRender() {} }, undefined).render(80);
    assert.equal(padded.length, first.length);
    assert.match(padded[0], /^Todos /, "the header stays on the first row");

    // An explicit expand is allowed to grow past the latch.
    widget.toggleExpanded();
    const grown = content({ requestRender() {} }, undefined).render(80);
    assert.ok(grown.length > first.length, "expanding grows the panel");
    // ...and collapsing goes back to the collapsed height, not the latched one.
    widget.toggleExpanded();
    const back = content({ requestRender() {} }, undefined).render(80);
    assert.equal(back.length, first.length);
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
