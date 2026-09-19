// codex-todo — LLM-facing tool. One tool, action-dispatched, so the model
// never resends whole documents: every mutation is a precise, validated,
// no-change-aware operation (rpiv-todo's ABI lesson — the tool name and
// parameter schema are a frozen contract; the disk schema carries a version
// field from day one for the same reason).
//
// Policy choices baked in here (docs/0.16.0-todo-plugin-plan.md):
// - Validation failures THROW (illegal transition, duplicate title, cycle,
//   completion gate) — the error text names the fix so the model self-corrects.
// - No-change situations return a success result ("No change: ...") — an error
//   would invite the model to retry the identical call in a loop (rpiv).
// - completion requires evidence and an unfinished-subtree check that BLOCKS
//   by default (pi-goal-x); evidence is recorded as an UNTRUSTED claim.
// - Optional evidenceFiles paths are checked against cwd: claiming work whose
//   artifacts don't exist yet is the cheapest lie to catch.

import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  addBlockedBy, addTasks, buildTree, claimTask, completeTask, flattenTree,
  formatTaskId, isBlocked, moveTask, nextTaskId, releaseTask,
  removeBlockedBy, skipTask, transitionTask, updateTitle,
  type ModelResult, type Task, type TodoState,
} from "./model.ts";
import type { TodoStore } from "./store.ts";

/** Everything the tool needs from its host extension. */
export interface CodexTodoSystem {
  store: TodoStore;
  turn(): number;
  /** Called after every successful mutation so the widget can refresh. */
  changed(): void;
}

const TaskAddItem = Type.Object({
  title: Type.String({ description: "Task title. Distinct from other open tasks (duplicate titles are rejected)." }),
  parentId: Type.Optional(Type.Number({ description: "Id of the parent task for subtasks. Omit for top-level tasks. Nesting deeper than 4 levels is rejected." })),
});

export const TodoToolParams = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("complete"),
    Type.Literal("skip"),
    Type.Literal("reopen"),
    Type.Literal("claim"),
    Type.Literal("release"),
    Type.Literal("addBlockedBy"),
    Type.Literal("removeBlockedBy"),
  ]),
  tasks: Type.Optional(Type.Array(TaskAddItem, { description: "add: flat list of new tasks (the extension builds the tree; do not nest JSON yourself)." })),
  id: Type.Optional(Type.Number({ description: "Target task id (#N) for single-task actions." })),
  title: Type.Optional(Type.String({ description: "update: new title." })),
  parentId: Type.Optional(Type.Number({ description: "update: new parent id, or null to move to top level. Moves that would create a cycle are rejected." })),
  evidence: Type.Optional(Type.String({ description: "complete: what proves the task is done. Recorded as an UNTRUSTED claim — be specific (what changed, where)." })),
  evidenceFiles: Type.Optional(Type.Array(Type.String(), { description: "complete: optional paths (cwd-relative or absolute) that must exist before completion is accepted." })),
  reason: Type.Optional(Type.String({ description: "skip: why the task is being skipped (recorded on the task and its unfinished subtasks)." })),
  blockedBy: Type.Optional(Type.Number({ description: "addBlockedBy/removeBlockedBy: the blocking task id." })),
  force: Type.Optional(Type.Boolean({ description: "claim/release: take over or release a task claimed by another session." })),
});

export interface TodoToolCall {
  action: string;
  tasks?: { title: string; parentId?: number }[];
  id?: number;
  title?: string;
  parentId?: number;
  evidence?: string;
  evidenceFiles?: string[];
  reason?: string;
  blockedBy?: number;
  force?: boolean;
}

export interface TodoToolResult {
  content: { type: "text"; text: string }[];
  /** Structured payload for logs or UI rendering. This tool returns none — the host's
   * AgentToolResult requires the field, so it is explicitly undefined. */
  details: undefined;
}

const text = (s: string): TodoToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

const statusGlyph = (t: Task, blocked: boolean): string =>
  blocked ? "⚠︎" : t.status === "complete" ? "✓" : t.status === "skipped" ? "✗" : t.status === "in_progress" ? "◐" : "○";

export function renderListText(state: TodoState, sessionId: string): string {
  const lines: string[] = [];
  const flat = flattenTree(buildTree(state));
  const anyBlockedBy = state.tasks.some((t) => t.blockedBy.length > 0);
  for (const node of flat) {
    const t = node.task;
    const blocked = isBlocked(state, t.id);
    const indent = "  ".repeat(node.depth - 1);
    const claim = t.claim ? (t.claim.session === sessionId ? " [mine]" : ` [${t.claim.session}]`) : "";
    const idPrefix = anyBlockedBy ? `${formatTaskId(t.id)} ` : "";
    lines.push(`${indent}${statusGlyph(t, blocked)} ${idPrefix}${t.title}${claim}${t.status === "skipped" && t.skipReason ? ` — ${t.skipReason}` : ""}`);
  }
  // Header counts EVERY task (rpiv-todo's Todos (done/total)); parents are
  // visible rows too, even though their work is delegated to children.
  const count = (s: Task["status"]) => state.tasks.filter((t) => t.status === s).length;
  const done = count("complete") + count("skipped");
  const summary = `Todos: ${done}/${state.tasks.length} done (${count("complete")} complete, ${count("skipped")} skipped) · ${count("in_progress")} in progress · ${count("pending")} pending`;
  const next = nextTaskId(state);
  return lines.length > 0
    ? `${summary}\n${lines.join("\n")}${next != null ? `\nnext: ${formatTaskId(next)}` : ""}`
    : `${summary}\n(no tasks — add some with the todo tool)`;
}

const requireId = (id: number | undefined): number => {
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("todo: id is required for this action");
  return id;
};

const checkEvidenceFiles = (files: string[] | undefined, cwd: string): void => {
  if (!files || files.length === 0) return;
  const missing = files.filter((f) => !existsSync(isAbsolute(f) ? f : join(cwd, f)));
  if (missing.length > 0) throw new Error(`completion blocked: evidence files do not exist — ${missing.join(", ")}`);
};

type RunOutcome<T> = { kind: "changed"; value: T } | { kind: "noop"; message: string };

export function createTodoToolHandlers(system: CodexTodoSystem, cwd: () => string, now: () => number = Date.now) {
  const run = async <T>(fn: (state: TodoState) => ModelResult<T>): Promise<RunOutcome<T>> => {
    const result = await system.store.mutate(fn);
    if (!result.ok) {
      if (/^no change:/.test(result.error)) return { kind: "noop", message: result.error };
      throw new Error(`todo: ${result.error}`);
    }
    system.changed();
    return { kind: "changed", value: result.value };
  };
  return async function execute(params: TodoToolCall, sessionId: string): Promise<TodoToolResult> {
    const { store, turn } = system;
    switch (params.action) {
      case "list":
        return text(renderListText(store.read(), sessionId));

      case "add": {
        if (!params.tasks || params.tasks.length === 0) throw new Error("todo add: tasks array required");
        const outcome = await run((s) => addTasks(s, params.tasks!, now()));
        if (outcome.kind === "noop") return text(outcome.message);
        const names = outcome.value.map((t) => `${formatTaskId(t.id)} ${t.title}`).join(", ");
        return text(`added ${outcome.value.length} task(s): ${names}`);
      }

      case "update": {
        const id = requireId(params.id);
        if (params.title === undefined && params.parentId === undefined) {
          return text("No change: nothing to update (pass title and/or parentId)");
        }
        // Run each sub-update independently — a no-op title must not swallow a
        // real parent move (and vice versa).
        let lastNoop: string | null = null;
        let anyChange = false;
        if (params.title !== undefined) {
          const outcome = await run((s) => updateTitle(s, id, params.title!, now()));
          if (outcome.kind === "changed") anyChange = true;
          else lastNoop = outcome.message;
        }
        if (params.parentId !== undefined) {
          const outcome = await run((s) => moveTask(s, id, params.parentId!, now()));
          if (outcome.kind === "changed") anyChange = true;
          else lastNoop = outcome.message;
        }
        if (!anyChange) return text(lastNoop ?? "No change: nothing to update");
        return text(`updated ${formatTaskId(id)}`);
      }

      case "complete": {
        const id = requireId(params.id);
        checkEvidenceFiles(params.evidenceFiles, cwd());
        const outcome = await run((s) => completeTask(s, id, params.evidence ?? "", now(), turn()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`completed ${formatTaskId(id)} (evidence recorded as an untrusted claim)`);
      }

      case "skip": {
        const id = requireId(params.id);
        const outcome = await run((s) => skipTask(s, id, params.reason ?? "", now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`skipped ${outcome.value.map((t) => formatTaskId(t.id)).join(", ")}`);
      }

      case "reopen": {
        const id = requireId(params.id);
        const outcome = await run((s) => transitionTask(s, id, "pending", now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`reopened ${formatTaskId(id)}`);
      }

      case "claim": {
        const id = requireId(params.id);
        const outcome = await run((s) => claimTask(s, id, sessionId, now(), params.force ?? false));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`claimed ${formatTaskId(id)} for ${sessionId}`);
      }

      case "release": {
        const id = requireId(params.id);
        const outcome = await run((s) => releaseTask(s, id, sessionId, now(), params.force ?? false));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`released ${formatTaskId(id)}`);
      }

      case "addBlockedBy": {
        const id = requireId(params.id);
        if (typeof params.blockedBy !== "number") throw new Error("todo addBlockedBy: blockedBy id required");
        const outcome = await run((s) => addBlockedBy(s, id, params.blockedBy!, now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`${formatTaskId(id)} is now blocked by ${formatTaskId(params.blockedBy)}`);
      }

      case "removeBlockedBy": {
        const id = requireId(params.id);
        if (typeof params.blockedBy !== "number") throw new Error("todo removeBlockedBy: blockedBy id required");
        const outcome = await run((s) => removeBlockedBy(s, id, params.blockedBy!, now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`${formatTaskId(id)} is no longer blocked by ${formatTaskId(params.blockedBy)}`);
      }

      default:
        throw new Error(`todo: unknown action "${params.action}"`);
    }
  };
}
