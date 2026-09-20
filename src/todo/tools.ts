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
  isBlocked, isListFinished, moveTask, nextTaskId, pathOf, releaseTask, resolveTaskRef, taskGlyph, taskPaths, type AddItem,
  removeBlockedBy, skipTask, startNewList, transitionTask, updateTitle,
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

/** A task reference: its hierarchical path ("2", "2.1", "#2.1"). Numbers are
 * tolerated for top-level tasks, since "2" and 2 mean the same thing. */
const TaskRefSchema = Type.Union([Type.String(), Type.Number()], {
  description: 'Task path: "1" for the first top-level task, "1.2" for its second subtask.',
});

const TaskAddItem = Type.Object({
  title: Type.String({ description: "Task title. Distinct from other open tasks (duplicate titles are rejected)." }),
  parentId: Type.Optional(TaskRefSchema),
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
  tasks: Type.Optional(Type.Array(TaskAddItem, { description: "add: flat array of new tasks (no nested JSON); nest by setting parentId to an earlier task of this same batch — e.g. [{title:\"A\"}, {title:\"A.1\", parentId:\"1\"}]." })),
  id: Type.Optional(TaskRefSchema),
  title: Type.Optional(Type.String({ description: "update: new title." })),
  parentId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()], { description: "update: new parent path, or null to move to top level. Moves that would create a cycle are rejected." })),
  evidence: Type.Optional(Type.String({ description: "complete: what proves the task is done. Recorded as an UNTRUSTED claim — be specific (what changed, where)." })),
  evidenceFiles: Type.Optional(Type.Array(Type.String(), { description: "complete: optional paths (cwd-relative or absolute) that must exist before completion is accepted." })),
  reason: Type.Optional(Type.String({ description: "skip: why the task is being skipped (recorded on the task and its unfinished subtasks)." })),
  blockedBy: Type.Optional(TaskRefSchema),
  force: Type.Optional(Type.Boolean({ description: "claim/release: take over or release a task claimed by another session." })),
});

export type TaskReference = string | number;

export interface TodoToolCall {
  action: string;
  tasks?: { title: string; parentId?: TaskReference }[];
  id?: TaskReference;
  title?: string;
  parentId?: TaskReference | null;
  evidence?: string;
  evidenceFiles?: string[];
  reason?: string;
  blockedBy?: TaskReference;
  force?: boolean;
}

export interface TodoToolResult {
  content: { type: "text"; text: string }[];
  /** Structured payload for logs or UI rendering. This tool returns none — the host's
   * AgentToolResult requires the field, so it is explicitly undefined. */
  details: undefined;
}

const text = (s: string): TodoToolResult => ({ content: [{ type: "text", text: s }], details: undefined });

export function renderListText(state: TodoState, sessionId: string): string {
  const lines: string[] = [];
  const flat = flattenTree(buildTree(state));
  const paths = taskPaths(state);
  const anyBlockedBy = state.tasks.some((t) => t.blockedBy.length > 0);
  for (const node of flat) {
    const t = node.task;
    const blocked = isBlocked(state, t.id);
    const indent = "  ".repeat(node.depth - 1);
    const claim = t.claim ? (t.claim.session === sessionId ? " [mine]" : ` [${t.claim.session}]`) : "";
    const idPrefix = anyBlockedBy ? `${paths.get(t.id)} ` : "";
    lines.push(`${indent}${taskGlyph(t, blocked)} ${idPrefix}${t.title}${claim}${t.status === "skipped" && t.skipReason ? ` — ${t.skipReason}` : ""}`);
  }
  // Header counts EVERY task (rpiv-todo's Todos (done/total)); parents are
  // visible rows too, even though their work is delegated to children.
  const count = (s: Task["status"]) => state.tasks.filter((t) => t.status === s).length;
  const done = count("complete") + count("skipped");
  const summary = `Todos: ${done}/${state.tasks.length} done (${count("complete")} complete, ${count("skipped")} skipped) · ${count("in_progress")} in progress · ${count("pending")} pending`;
  const next = nextTaskId(state);
  return lines.length > 0
    ? `${summary}\n${lines.join("\n")}${next != null ? `\nnext: ${paths.get(next)}` : ""}`
    : `${summary}\n(no tasks — add some with the todo tool)`;
}

const requireRef = (ref: TaskReference | undefined, action: string): TaskReference => {
  if (typeof ref === "string" && ref.trim() !== "") return ref;
  if (typeof ref === "number" && Number.isInteger(ref)) return ref;
  throw new Error(`todo ${action}: a task path is required (e.g. id: "2.1")`);
};

/** Resolve a path against the state the mutation will run on. */
const refId = (state: TodoState, ref: TaskReference): number => {
  const resolved = resolveTaskRef(state, ref);
  if (!resolved.ok) throw new Error(`todo: ${resolved.error}`);
  return resolved.id;
};

/**
 * Model-level errors speak in internal ids ("task #13 not found"); the user and
 * the model only ever see paths, so rewrite every `#<digits>` before it leaves.
 */
const translateIds = (message: string, state: TodoState): string => {
  const paths = taskPaths(state);
  return message.replace(/#(\d+)(?!\.\d)/g, (whole, digits: string) => paths.get(Number(digits)) ?? whole);
};

const checkEvidenceFiles = (files: string[] | undefined, cwd: string): void => {
  if (!files || files.length === 0) return;
  const missing = files.filter((f) => !existsSync(isAbsolute(f) ? f : join(cwd, f)));
  if (missing.length > 0) throw new Error(`completion blocked: evidence files do not exist — ${missing.join(", ")}`);
};

type RunOutcome<T> =
  | { kind: "changed"; value: T; state: TodoState }
  | { kind: "noop"; message: string };

export function createTodoToolHandlers(system: CodexTodoSystem, cwd: () => string, now: () => number = Date.now) {
  const run = async <T>(fn: (state: TodoState) => ModelResult<T>): Promise<RunOutcome<T>> => {
    const result = await system.store.mutate(fn);
    if (!result.ok) {
      const message = translateIds(result.error, system.store.read());
      if (/^no change:/.test(result.error)) return { kind: "noop", message };
      throw new Error(`todo: ${message}`);
    }
    system.changed();
    return { kind: "changed", value: result.value, state: result.state };
  };
  return async function execute(params: TodoToolCall, sessionId: string): Promise<TodoToolResult> {
    const { store, turn } = system;
    switch (params.action) {
      case "list":
        return text(renderListText(store.read(), sessionId));

      case "add": {
        if (!params.tasks || params.tasks.length === 0) throw new Error("todo add: tasks array required");
        // A finished list is history: new work starts a NEW list instead of
        // appending to it (0.19.4). Appending is only for a list that still has
        // live work — otherwise the panel accumulates one growing list forever.
        // Ids restart at #1 with the new list, so the note spells out that
        // earlier #id references are void: this is the one moment ids are reused.
        let cleared = 0;
        const outcome = await run((s) => {
          let base = s;
          if (isListFinished(s)) {
            cleared = s.tasks.length;
            base = startNewList(s);
          }
          // Parent paths resolve against a projection that already contains the
          // earlier items of this batch, so `[{title:"parent"}, {parentId:"1"}]`
          // nests in one call (the projection is discarded: the real append below
          // re-validates the whole batch and assigns identical ids).
          const items: AddItem[] = [];
          let projection = base;
          for (const t of params.tasks!) {
            const parentId =
              t.parentId === undefined || t.parentId === null ? undefined : refId(projection, t.parentId);
            const item: AddItem = { title: t.title, parentId };
            items.push(item);
            const probe = addTasks(projection, [item], now());
            if (!probe.ok) return probe; // the same batch would fail on the real append
            projection = probe.state;
          }
          return addTasks(base, items, now());
        });
        if (outcome.kind === "noop") return text(outcome.message);
        const names = outcome.value.map((t) => `${pathOf(outcome.state, t.id)} ${t.title}`).join(", ");
        const note =
          cleared > 0
            ? ` (new list: ${cleared} finished task(s) cleared; ids restart at #1 — earlier #id references are void)`
            : "";
        return text(`added ${outcome.value.length} task(s): ${names}${note}`);
      }

      case "update": {
        const ref = requireRef(params.id, "update");
        if (params.title === undefined && params.parentId === undefined) {
          return text("No change: nothing to update (pass title and/or parentId)");
        }
        // Run each sub-update independently — a no-op title must not swallow a
        // real parent move (and vice versa).
        let lastNoop: string | null = null;
        let anyChange = false;
        let lastState: TodoState | null = null;
        let lastId: number | null = null;
        if (params.title !== undefined) {
          const outcome = await run((s) => updateTitle(s, refId(s, ref), params.title!, now()));
          if (outcome.kind === "changed") {
            anyChange = true;
            lastState = outcome.state;
            lastId = outcome.value.id;
          } else lastNoop = outcome.message;
        }
        if (params.parentId !== undefined) {
          const parent = params.parentId;
          const outcome = await run((s) => moveTask(s, refId(s, ref), parent === null ? null : refId(s, parent), now()));
          if (outcome.kind === "changed") {
            anyChange = true;
            lastState = outcome.state;
            lastId = outcome.value.id;
          } else lastNoop = outcome.message;
        }
        if (!anyChange) return text(lastNoop ?? "No change: nothing to update");
        return text(`updated ${lastState && lastId !== null ? pathOf(lastState, lastId) : String(ref)}`);
      }

      case "complete": {
        const ref = requireRef(params.id, "complete");
        checkEvidenceFiles(params.evidenceFiles, cwd());
        const outcome = await run((s) => completeTask(s, refId(s, ref), params.evidence ?? "", now(), turn()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`completed ${pathOf(outcome.state, outcome.value.id)} (evidence recorded as an untrusted claim)`);
      }

      case "skip": {
        const ref = requireRef(params.id, "skip");
        const outcome = await run((s) => skipTask(s, refId(s, ref), params.reason ?? "", now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`skipped ${outcome.value.map((t) => pathOf(outcome.state, t.id)).join(", ")}`);
      }

      case "reopen": {
        const ref = requireRef(params.id, "reopen");
        const outcome = await run((s) => transitionTask(s, refId(s, ref), "pending", now()));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`reopened ${pathOf(outcome.state, outcome.value.id)}`);
      }

      case "claim": {
        const ref = requireRef(params.id, "claim");
        const outcome = await run((s) => claimTask(s, refId(s, ref), sessionId, now(), params.force ?? false));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`claimed ${pathOf(outcome.state, outcome.value.id)} for ${sessionId}`);
      }

      case "release": {
        const ref = requireRef(params.id, "release");
        const outcome = await run((s) => releaseTask(s, refId(s, ref), sessionId, now(), params.force ?? false));
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`released ${pathOf(outcome.state, outcome.value.id)}`);
      }

      case "addBlockedBy": {
        const ref = requireRef(params.id, "addBlockedBy");
        const dependency = requireRef(params.blockedBy, "addBlockedBy");
        let target = 0;
        let blocker = 0;
        const outcome = await run((s) => {
          target = refId(s, ref);
          blocker = refId(s, dependency);
          return addBlockedBy(s, target, blocker, now());
        });
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`${pathOf(outcome.state, target)} is now blocked by ${pathOf(outcome.state, blocker)}`);
      }

      case "removeBlockedBy": {
        const ref = requireRef(params.id, "removeBlockedBy");
        const dependency = requireRef(params.blockedBy, "removeBlockedBy");
        let target = 0;
        let blocker = 0;
        const outcome = await run((s) => {
          target = refId(s, ref);
          blocker = refId(s, dependency);
          return removeBlockedBy(s, target, blocker, now());
        });
        if (outcome.kind === "noop") return text(outcome.message);
        return text(`${pathOf(outcome.state, target)} is no longer blocked by ${pathOf(outcome.state, blocker)}`);
      }

      default:
        throw new Error(`todo: unknown action "${params.action}"`);
    }
  };
}
