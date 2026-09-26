import type { Task, TodoState } from "../../src/todo/model.ts";

/** Data only: behavior under test is explicit in each task override. */
export function todoState(...items: (string | (Partial<Task> & { title: string }))[]): TodoState {
  const tasks = items.map((item, index): Task => ({
    id: index + 1, parentId: null, status: "pending",
    blockedBy: [], claim: null, evidence: null, skipReason: null,
    createdAt: 1, updatedAt: 1, completedAt: null, completedAtTurn: null,
    ...(typeof item === "string" ? { title: item } : item),
  }));
  return { version: 1, nextId: Math.max(0, ...tasks.map((task) => task.id)) + 1, tasks };
}
