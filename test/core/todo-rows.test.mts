import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildTodoRows } from "../../src/todo/widget.ts";
import { renderListText } from "../../src/todo/tools.ts";
import { todoState } from "../helpers/todo.mts";

const rows = (state: ReturnType<typeof todoState>, width = 80) => buildTodoRows(
  state, { width, turn: 5, sessionId: "sess-A", expanded: false, maxLines: 5 }, truncateToWidth,
).map((row) => row.text);

test("rows indent descendants when parents were created after children", () => {
  const state = todoState(
    { title: "early child", parentId: 2 }, { title: "later parent", parentId: 3 }, "root",
  );
  assert.deepEqual(rows(state).slice(1), ["○ root", "  ○ later parent", "    ○ early child", ""]);
});

test("rows show hierarchy and claims, adding paths and blocked glyphs only with edges", () => {
  const state = todoState("root", {
    title: "child", parentId: 1, status: "in_progress", claim: { session: "sess-A", at: 3 },
  }, "solo");
  assert.deepEqual(rows(state), ["Todos 0/3 done", "○ root", "  ◐ child · mine", "○ solo", ""]);
  state.tasks[2].blockedBy = [1];
  assert.match(rows(state)[2], /◐ #1\.1 child · mine/);
  assert.match(rows(state)[3], /⚠︎ #2 solo/);
});

test("overflow drops completed rows first and fits the line budget", () => {
  const state = todoState("live1", "live2", "live3", ...[4, 5].map((id) => ({
    title: `done${id}`, status: "complete" as const, evidence: "done", completedAt: 2, completedAtTurn: 5,
  })));
  const frame = rows(state);
  assert.match(frame[0], /Todos 2\/5 done/);
  assert.equal(frame.findIndex((row) => row.startsWith("+")), 4);
  assert.deepEqual(frame.slice(1, 4), ["○ live1", "○ live2", "○ live3"]);
  assert.match(frame[4], /\+2 more \(2 completed, 0 pending\)/);
  assert.ok(frame.length <= 6);
});

test("width truncation keeps CJK, combining and emoji rows within terminal columns", () => {
  const state = todoState(...["中文", "e\u0301", "👩‍💻"].map((part) => part.repeat(50)));
  for (const width of [1, 4, 8, 12, 40]) {
    for (const text of rows(state, width)) assert.ok(visibleWidth(text) <= width, `${width} columns: ${JSON.stringify(text)}`);
  }
});

test("plain-text lists show claims and the next suggestion without opening a store", () => {
  const state = todoState("a", {
    title: "b", status: "in_progress", claim: { session: "agent-X", at: 2 },
  }, "c");
  assert.match(renderListText(state, "s"), /○ a[\s\S]*◐ b \[agent-X\][\s\S]*next: #1/);
  assert.match(renderListText(state, "agent-X"), /\[mine\]/);
});
