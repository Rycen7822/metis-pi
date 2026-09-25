// codex-todo widget tests — pure rows, register-once contract, fold persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTodoStore, TODO_STATE_FILE } from "../../src/todo/store.ts";
import { addTasks, claimTask, completeTask, moveTask } from "../../src/todo/model.ts";
import { createTodoWidget, TODO_WIDGET_KEY, TODO_WIDGET_PLACEMENT } from "../../src/todo/widget.ts";
import type { CodexTodoSystem } from "../../src/todo/tools.ts";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-todo-widget-"));
  let turn = 5;
  let session = "sess-A";
  const store = openTodoStore(dir);
  const system: CodexTodoSystem = { store, turn: () => turn, changed: () => {} };
  const widget = createTodoWidget({ system, sessionId: () => session });
  const calls: { key: string; content: unknown; options?: unknown }[] = [];
  const fakeUi = {
    setWidget: (key: string, content: unknown, options?: unknown) => calls.push({ key, content, options }),
  };
  widget.attach(fakeUi);
  return { dir, store, system, widget, calls, turns: { set: (t: number) => { turn = t; }, get: () => turn }, setSession: (id: string) => { session = id; } };
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

test("a list finished in an earlier session never pops the panel up (restart)", async () => {
  const { dir, store, widget, calls } = setup();
  try {
    // What a restart finds: finished work with old timestamps and old ordinals,
    // while this session's turn counter starts over at 0.
    const when = Date.now() - 3_600_000;
    writeFileSync(join(dir, TODO_STATE_FILE), JSON.stringify({
      version: 1,
      nextId: 3,
      tasks: [
        { id: 1, title: "shipped", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: when, updatedAt: when, completedAt: when, completedAtTurn: 3 },
        { id: 2, title: "also shipped", parentId: null, status: "complete", blockedBy: [], claim: null, evidence: "e", skipReason: null, createdAt: when, updatedAt: when, completedAt: when, completedAtTurn: 4 },
      ],
    }), "utf8");

    widget.refresh();
    assert.equal(calls.length, 0, "no panel for work that was already done when the session started");
    assert.equal(widget.visibleRows(store.read(), 0), false, "visibleRows agrees at turn 0");

    // New work registers the panel again: the session gate must not disable it.
    await stateWith(store, [{ title: "fresh task" }]);
    widget.refresh();
    assert.equal(calls.length, 1, "a new task brings the panel back");
    assert.equal(widget.visibleRows(store.read(), 0), true, "an unfinished task always shows");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rows indent descendants correctly after reparenting to a newer task", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "early child" }, { title: "later parent" }, { title: "root" }]);
    assert.ok((await store.mutate((s) => moveTask(s, 2, 3, 2))).ok);
    assert.ok((await store.mutate((s) => moveTask(s, 1, 2, 3))).ok);
    assert.deepEqual(widget.buildRows(store.read(), 80, 5).map((r) => r.text).slice(1), [
      "○ root", "  ○ later parent", "    ○ early child", "",
    ]);
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
    assert.match(rows2[2], /◐ #1\.1 child · mine/); // subtask path, not a running number
    assert.match(rows2[3], /⚠︎ #2 solo/); // edge exists → paths appear
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

test("a left click on the panel toggles the full list; other events pass through", async () => {
  const { dir, store, widget } = setup();
  try {
    await stateWith(store, [{ title: "a" }, { title: "b" }, { title: "c" }, { title: "d" }, { title: "e" }]);
    const component = widget.component({ requestRender() {} });
    assert.equal(typeof component.handleMouse, "function");
    const collapsed = component.render(80);
    assert.equal(collapsed.length, 6); // header + 3 body + summary + spacer

    // Non-click events are ignored so the transcript keeps them. A right
    // PRESS hides the panel and is covered by the hide test below; a bare
    // right click never occurs in practice (an unclaimed press means the host
    // never synthesizes one) and is ignored.
    assert.equal(component.handleMouse?.({ type: "wheel", button: "none", wheelDelta: 3 }), undefined);
    assert.equal(component.handleMouse?.({ type: "press", button: "left" }), undefined);
    assert.equal(component.handleMouse?.({ type: "click", button: "middle" }), undefined);
    assert.equal(component.handleMouse?.({ type: "click", button: "right" }), undefined);

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
    // The right press hides immediately and is deliberately NOT claimed:
    // Warp forwards the press but eats the release (its menu takes it), and a
    // claimed press would leave a stale host-side press target swallowing
    // later clicks. No release, no click — the press alone must do it.
    const pressed = component.handleMouse?.({ type: "press", button: "right" });
    assert.equal(pressed, undefined);
    assert.equal(widget.isHidden(), true);
    assert.equal(component.handleMouse?.({ type: "click", button: "right" }), undefined);
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

test("unchanged frames reuse raw rows across component factories, but layout/session/turn changes rebuild", async (t) => {
  const { dir, store, system, widget, turns, setSession } = setup();
  t.after(() => { widget.detach(); store.dispose(); rmSync(dir, { recursive: true, force: true }); });
  await stateWith(store, [{ title: "claimed task" }, { title: "completed task" }]);
  await store.mutate((state) => claimTask(state, 1, "sess-A", 2));
  await store.mutate((state) => completeTask(state, 2, "evidence", Date.now(), turns.get()));
  const state = store.read();
  let traversals = 0;
  const tracked = { ...state, get tasks() { traversals += 1; return state.tasks; } };
  system.store = { ...store, snapshot: () => tracked };
  let color = "first";
  const frame = (width = 80) => widget.component({}, { fg: (_tone, text) => `${color}:${text}` }).render(width).join("\n");
  assert.match(frame(), /mine/);
  const built = traversals;
  for (let i = 0; i < 100; i += 1) frame();
  assert.equal(traversals, built, "animation-only frames do not traverse/build the tree");
  color = "second";
  assert.match(frame(), /^second:Todos/);
  assert.equal(traversals, built, "theme painting stays live without rebuilding rows");
  frame(40);
  assert.ok(traversals > built, "width invalidates layout");
  setSession("sess-B");
  assert.match(frame(), /sess-A/);
  assert.doesNotMatch(frame(), /mine/);
  turns.set(6);
  assert.doesNotMatch(frame(), /completed task/, "turn invalidation folds completed rows");
  widget.toggleExpanded();
  assert.match(frame(), /click to collapse/);
  widget.toggleExpanded();
  assert.doesNotMatch(frame(), /click to collapse/);
  const beforeDetach = traversals;
  widget.detach();
  frame();
  assert.ok(traversals > beforeDetach, "detach releases the retained rows");
});

test("a visible component sees external edits and recovers from explicit, width-bounded snapshot failures", async (t) => {
  const { dir, store, system, widget } = setup();
  t.after(() => { widget.detach(); store.dispose(); rmSync(dir, { recursive: true, force: true }); });
  await stateWith(store, [{ title: "before" }]);
  const component = widget.component({});
  assert.match(component.render(80).join("\n"), /before/);
  const external = store.read();
  external.tasks[0].title = "after external edit";
  writeFileSync(join(dir, TODO_STATE_FILE), JSON.stringify(external));
  assert.match(component.render(80).join("\n"), /after external edit/);

  const snapshot = store.snapshot();
  let traversals = 0;
  let reads = 0;
  let failure: Error | undefined;
  const tracked = { ...snapshot, get tasks() { traversals += 1; return snapshot.tasks; } };
  system.store = { ...store, snapshot() {
    reads += 1;
    if (failure) throw failure;
    return tracked;
  } };
  assert.match(component.render(80).join("\n"), /after external edit/);
  for (const code of ["EACCES", "EIO"]) {
    const built = traversals;
    failure = Object.assign(new Error("disk unavailable"), { code });
    assert.deepEqual(component.render(80).filter(Boolean), ["Todos unavailable"], "no stale tasks or empty success");
    for (const width of [0, 1, 8, 17, 80]) {
      const before = reads;
      const frame = component.render(width);
      assert.ok(frame.every((line) => [...line].length <= width), `unavailable rows fit width ${width}`);
      assert.equal(reads, before + 1, "failures are retried on every render, not cached");
    }
    assert.equal(traversals, built, "failed snapshots do not rebuild stale tasks");
    failure = undefined;
    assert.match(component.render(80).join("\n"), /after external edit/, "the next successful read recovers immediately");
    assert.ok(traversals > built, "failure cleared rows even when recovery returns the same state identity");
    const recovered = traversals;
    component.render(80);
    assert.equal(traversals, recovered, "successful frames still reuse their row cache");
  }
});

