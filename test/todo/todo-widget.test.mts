// Rows, registration, gestures and cache lifetime over a real tmpdir store.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectory } from "../helpers/temp-dir.mjs";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";
import { addTasks, claimTask, completeTask, moveTask } from "../../src/todo/model.ts";
import { createTodoWidget, TODO_WIDGET_KEY, TODO_WIDGET_PLACEMENT } from "../../src/todo/widget.ts";

function setup(t: TestContext) {
  const dir = temporaryDirectory(t);
  let turn = 5;
  let session = "sess-A";
  const store = openTodoStore(dir);
  const system = { store, turn: () => turn, changed() {} };
  const widget = createTodoWidget({ system, sessionId: () => session });
  t.after(() => { widget.detach(); store.dispose(); });
  const calls: { key: string; content: unknown; options?: unknown }[] = [];
  widget.attach({ setWidget: (key, content, options) => calls.push({ key, content, options }) });
  const add = async (...items: (string | { title: string; parentId?: number })[]) => {
    const result = await store.mutate((state) => addTasks(state, items.map((item) => typeof item === "string" ? { title: item } : item), 1));
    assert.ok(result.ok, result.ok ? "" : result.error);
  };
  const complete = async (...ids: number[]) => {
    for (const id of ids) assert.ok((await store.mutate((state) => completeTask(state, id, "evidence", Date.now(), turn))).ok);
  };
  return { dir, store, system, widget, calls, add, complete,
    rows: (width = 80) => widget.buildRows(store.read(), width, turn).map((row) => row.text),
    setTurn: (value: number) => { turn = value; }, setSession: (value: string) => { session = value; } };
}

test("hidden when empty, register-once on first task, unregister when all done folds", async (t) => {
  const { widget, calls, add, complete, setTurn } = setup(t);
  widget.refresh();
  assert.equal(calls.length, 0);
  await add("a", "b");
  widget.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, TODO_WIDGET_KEY);
  assert.equal((calls[0].options as { placement: string }).placement, TODO_WIDGET_PLACEMENT);
  widget.refresh();
  assert.equal(calls.length, 1, "unchanged refresh does not register again");
  await complete(1, 2);
  widget.refresh();
  assert.equal(calls.length, 1, "current-turn completion stays visible");
  setTurn(6);
  widget.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].content, undefined);
});

test("a list finished in an earlier session stays hidden, but new tasks reopen it", async (t) => {
  const { dir, store, widget, calls, add } = setup(t);
  const when = Date.now() - 3_600_000;
  writeFileSync(join(dir, TODO_STATE_FILE), JSON.stringify({
    version: 1, nextId: 3,
    tasks: [1, 2].map((id) => ({
      id, title: `shipped ${id}`, parentId: null, status: "complete", blockedBy: [], claim: null,
      evidence: "e", skipReason: null, createdAt: when, updatedAt: when, completedAt: when, completedAtTurn: id + 2,
    })),
  }));
  widget.refresh();
  assert.equal(calls.length, 0);
  assert.equal(widget.visibleRows(store.read(), 0), false);
  await add("fresh task");
  widget.refresh();
  assert.equal(calls.length, 1);
  assert.equal(widget.visibleRows(store.read(), 0), true);
});

test("rows indent descendants correctly after reparenting to a newer task", async (t) => {
  const { store, add, rows } = setup(t);
  await add("early child", "later parent", "root");
  assert.ok((await store.mutate((state) => moveTask(state, 2, 3, 2))).ok);
  assert.ok((await store.mutate((state) => moveTask(state, 1, 2, 3))).ok);
  assert.deepEqual(rows().slice(1), ["○ root", "  ○ later parent", "    ○ early child", ""]);
});

test("rows show hierarchy and claims, adding paths and blocked glyphs only with edges", async (t) => {
  const { store, add, rows } = setup(t);
  await add("root", { title: "child", parentId: 1 }, "solo");
  await store.mutate((state) => claimTask(state, 2, "sess-A", 3));
  const plain = rows();
  for (const [index, expected] of [/Todos 0\/3 done/, /○ root/, /◐ child · mine/, /○ solo/].entries()) assert.match(plain[index], expected);
  assert.equal(plain.at(-1), "");
  assert.ok(!plain.slice(1, -1).some((line) => line.includes("#")));
  await store.mutate((state) => ({ ok: true, value: undefined,
    state: { ...state, tasks: state.tasks.map((task) => task.id === 3 ? { ...task, blockedBy: [1] } : task) },
  }));
  assert.match(rows()[2], /◐ #1\.1 child · mine/);
  assert.match(rows()[3], /⚠︎ #2 solo/);
});

test("overflow drops completed rows first and fits the line budget", async (t) => {
  const { add, complete, rows } = setup(t);
  await add("live1", "live2", "live3", "live4", "live5");
  await complete(4, 5);
  const frame = rows();
  assert.match(frame[0], /Todos 2\/5 done/);
  assert.equal(frame.findIndex((row) => row.startsWith("+")), 4);
  assert.deepEqual(frame.slice(1, 4).map((row) => row.slice(2, 7)), ["live1", "live2", "live3"]);
  assert.match(frame[4], /\+2 more \(2 completed, 0 pending\)/);
  assert.ok(frame.length <= 6);
});

test("a left click toggles the full list; other events pass through", async (t) => {
  const { add, widget } = setup(t);
  await add("a", "b", "c", "d", "e");
  const component = widget.component({ requestRender() {} });
  assert.equal(typeof component.handleMouse, "function");
  assert.equal(component.render(80).length, 6);
  for (const event of [
    { type: "wheel", button: "none", wheelDelta: 3 }, { type: "press", button: "left" },
    { type: "click", button: "middle" }, { type: "click", button: "right" },
  ] as const) assert.equal(component.handleMouse?.(event), undefined);
  assert.deepEqual(component.handleMouse?.({ type: "click", button: "left" }), { handled: true });
  assert.equal(widget.isExpanded(), true);
  assert.equal(component.render(80).length, 7);
  assert.ok(component.render(80).some((line) => line.includes("click to collapse")));
  component.handleMouse?.({ type: "click", button: "left" });
  assert.equal(widget.isExpanded(), false);
  assert.equal(component.render(80).length, 6);
  assert.match(component.render(80)[0], /click to expand/);
});

test("an unclaimed right press hides persistently; show restores registration", async (t) => {
  const { add, store, widget, calls } = setup(t);
  await add("a", "b");
  widget.refresh();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].content != null);
  const component = widget.component({ requestRender() {} });
  // Warp eats the release: claiming the press would strand the host press target.
  assert.equal(component.handleMouse?.({ type: "press", button: "right" }), undefined);
  assert.equal(widget.isHidden(), true);
  assert.equal(component.handleMouse?.({ type: "click", button: "right" }), undefined);
  assert.equal(widget.isHidden(), true);
  assert.equal(store.settings().widgetHidden, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].key, TODO_WIDGET_KEY);
  assert.equal(calls[1].content, undefined);
  await add("c");
  widget.refresh();
  assert.equal(calls.length, 2);
  widget.show();
  assert.equal(widget.isHidden(), false);
  assert.equal(store.settings().widgetHidden, false);
  assert.equal(calls.length, 3);
  assert.ok(calls[2].content != null);
  await add("d");
  widget.refresh();
  assert.equal(calls.length, 3);
});

test("the live latch pads completion, permits expansion, and resets on collapse", async (t) => {
  const { add, complete, widget, calls } = setup(t);
  await add("a", "b", "c", "d", "e");
  widget.refresh();
  const content = calls[0].content as (tui: unknown, theme: unknown) => { render(width: number): string[] };
  const frame = () => content({ requestRender() {} }, undefined).render(80);
  assert.equal(frame().length, 6);
  await complete(1, 2);
  assert.equal(frame().length, 6);
  assert.match(frame()[0], /^Todos /);
  widget.toggleExpanded();
  assert.ok(frame().length > 6);
  widget.toggleExpanded();
  assert.equal(frame().length, 6);
});

test("width truncation keeps lines within budget", async (t) => {
  const { add, rows } = setup(t);
  await add("x".repeat(200));
  assert.ok(rows(40).every((text) => [...text].length <= 40));
});

test("unchanged frames reuse rows across factories; theme stays live and layout/session/turn invalidate", async (t) => {
  const { store, system, widget, add, complete, setTurn, setSession } = setup(t);
  await add("claimed task", "completed task");
  await store.mutate((state) => claimTask(state, 1, "sess-A", 2));
  await complete(2);
  const state = store.read();
  let traversals = 0;
  const tracked = { ...state, get tasks() { traversals++; return state.tasks; } };
  system.store = { ...store, snapshot: () => tracked };
  let color = "first";
  const frame = (width = 80) => widget.component({}, { fg: (_tone, text) => `${color}:${text}` }).render(width).join("\n");
  assert.match(frame(), /mine/);
  const built = traversals;
  for (let i = 0; i < 100; i++) frame();
  assert.equal(traversals, built);
  color = "second";
  assert.match(frame(), /^second:Todos/);
  assert.equal(traversals, built, "painting does not rebuild rows");
  frame(40);
  assert.ok(traversals > built);
  setSession("sess-B");
  assert.match(frame(), /sess-A/);
  assert.doesNotMatch(frame(), /mine/);
  setTurn(6);
  assert.doesNotMatch(frame(), /completed task/);
  widget.toggleExpanded();
  assert.match(frame(), /click to collapse/);
  widget.toggleExpanded();
  assert.doesNotMatch(frame(), /click to collapse/);
  const beforeDetach = traversals;
  widget.detach();
  frame();
  assert.ok(traversals > beforeDetach);
});

test("visible components see external edits and recover from width-bounded snapshot failures", async (t) => {
  const { dir, store, system, widget, add } = setup(t);
  await add("before");
  const component = widget.component({});
  assert.match(component.render(80).join("\n"), /before/);
  const external = store.read();
  external.tasks[0].title = "after external edit";
  writeFileSync(join(dir, TODO_STATE_FILE), JSON.stringify(external));
  assert.match(component.render(80).join("\n"), /after external edit/);
  const snapshot = store.snapshot();
  let traversals = 0;
  let failure: Error | undefined;
  const tracked = { ...snapshot, get tasks() { traversals++; return snapshot.tasks; } };
  const read = t.mock.fn(() => { if (failure) throw failure; return tracked; });
  system.store = { ...store, snapshot: read };
  assert.match(component.render(80).join("\n"), /after external edit/);
  for (const code of ["EACCES", "EIO"]) {
    const built = traversals;
    failure = Object.assign(new Error("disk unavailable"), { code });
    assert.deepEqual(component.render(80).filter(Boolean), ["Todos unavailable"]);
    for (const width of [0, 1, 8, 17, 80]) {
      const before = read.mock.callCount();
      assert.ok(component.render(width).every((line) => [...line].length <= width));
      assert.equal(read.mock.callCount(), before + 1, "retry each render, never cache failures");
    }
    assert.equal(traversals, built, "failed snapshots do not rebuild stale tasks");
    failure = undefined;
    assert.match(component.render(80).join("\n"), /after external edit/);
    assert.ok(traversals > built, "recovery with the same snapshot identity still rebuilds");
    const recovered = traversals;
    component.render(80);
    assert.equal(traversals, recovered);
  }
});
