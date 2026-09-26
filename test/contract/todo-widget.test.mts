// Widget owns registration, gestures and cached projection over controlled snapshots.
// The real store/settings bridge belongs to the shipped extension entry contract.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { todoState } from "../helpers/todo.mts";
import { createTodoWidget, TODO_WIDGET_KEY, TODO_WIDGET_PLACEMENT, type TodoWidgetDeps } from "../../src/todo/widget.ts";

function setup(t: TestContext, state = todoState()) {
  const input = { state, turn: 5, session: "sess-A" };
  let settings = { gcDays: 7, widgetExpanded: false, widgetHidden: false };
  const store: TodoWidgetDeps["system"]["store"] = {
    snapshot: () => input.state,
    settings: () => settings,
    saveSettings: (patch) => (settings = { ...settings, ...patch }),
  };
  const widget = createTodoWidget({ system: { store, turn: () => input.turn }, sessionId: () => input.session, truncateToWidth });
  t.after(() => widget.detach());
  const calls: { key: string; content: unknown; options?: unknown }[] = [];
  widget.attach({ setWidget: (key, content, options) => calls.push({ key, content, options }) });
  return { input, store, widget, calls };
}

test("tasks register once; left clicks toggle expansion and completion padding survives factory recreation", (t) => {
  const { input, widget, calls } = setup(t, todoState("a", "b", "c", "d", "e"));
  widget.refresh();
  widget.refresh();
  assert.equal(calls.length, 1, "new tasks register once across repeated refreshes");
  assert.equal(calls[0].key, TODO_WIDGET_KEY);
  assert.deepEqual(calls[0].options, { placement: TODO_WIDGET_PLACEMENT });
  const component = widget.component({ requestRender() {} });
  const frame = () => widget.component({}).render(80);
  assert.equal(frame().length, 6);
  for (const event of [
    { type: "wheel", button: "none", wheelDelta: 3 }, { type: "press", button: "left" },
    { type: "click", button: "middle" }, { type: "click", button: "right" },
  ] as const) assert.equal(component.handleMouse?.(event), undefined);
  assert.deepEqual(component.handleMouse?.({ type: "click", button: "left" }), { handled: true });
  assert.equal(widget.isExpanded(), true);
  assert.equal(frame().length, 7);
  assert.match(frame().join("\n"), /click to collapse/);
  component.handleMouse?.({ type: "click", button: "left" });
  assert.equal(widget.isExpanded(), false);
  assert.equal(frame().length, 6);
  input.state = todoState(...input.state.tasks.map((task) => task.id > 2 ? task : {
    ...task, status: "complete" as const, evidence: "done", completedAt: Date.now(), completedAtTurn: 5,
  }));
  assert.equal(frame().length, 6, "completion preserves the latched height");
  widget.toggleExpanded();
  assert.equal(frame().length, 7);
  widget.toggleExpanded();
  assert.equal(frame().length, 6);
  assert.match(frame()[0], /click to expand/);
});

test("factories cache rows, keep theme live, invalidate by layout/session/turn, and retry snapshot failures", (t) => {
  const { input, store, widget } = setup(t, todoState({
    title: "claimed task", status: "in_progress", claim: { session: "sess-A", at: 2 },
  }, { title: "completed task", status: "complete", evidence: "done", completedAt: Date.now(), completedAtTurn: 5 }));
  const state = input.state;
  let traversals = 0;
  let failure: Error | undefined;
  input.state = { ...state, get tasks() { traversals++; return state.tasks; } };
  const read = t.mock.method(store, "snapshot", () => { if (failure) throw failure; return input.state; });
  let color = "first";
  const frame = (width = 80) => widget.component({}, { fg: (_tone, text) => `${color}:${text}` }).render(width);
  assert.match(frame().join("\n"), /mine/);
  const built = traversals;
  for (let i = 0; i < 100; i++) frame();
  assert.equal(traversals, built);
  color = "second";
  assert.match(frame()[0], /^second:Todos/);
  assert.equal(traversals, built, "painting does not rebuild rows");
  frame(40);
  assert.ok(traversals > built);
  input.session = "sess-B";
  assert.match(frame().join("\n"), /sess-A/);
  assert.doesNotMatch(frame().join("\n"), /mine/);
  input.turn = 6;
  assert.doesNotMatch(frame().join("\n"), /completed task/);
  widget.toggleExpanded();
  assert.match(frame().join("\n"), /click to collapse/);
  widget.toggleExpanded();
  assert.doesNotMatch(frame().join("\n"), /click to collapse/);
  const beforeDetach = traversals;
  widget.detach();
  frame();
  assert.ok(traversals > beforeDetach);
  const component = widget.component({});
  for (const code of ["EACCES", "EIO"]) {
    const before = traversals;
    failure = Object.assign(new Error("disk unavailable"), { code });
    assert.deepEqual(component.render(80).filter(Boolean), ["Todos unavailable"]);
    for (const width of [0, 1, 8, 17, 80]) {
      const calls = read.mock.callCount();
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      assert.equal(read.mock.callCount(), calls + 1, "retry each render, never cache failures");
    }
    assert.equal(traversals, before, "failed snapshots do not rebuild stale tasks");
    failure = undefined;
    assert.match(component.render(80).join("\n"), /claimed task/);
    assert.ok(traversals > before, "same-identity recovery rebuilds");
    const recovered = traversals;
    component.render(80);
    assert.equal(traversals, recovered);
  }
});
