// codex-todo — pi extension entry. Wires the disk store, the model-facing
// todo tool, the user-facing commands, and lifecycle events. The persistent
// widget registers itself as the changed hook (see src/todo/widget.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { openTodoStore, TODO_DIR_NAME, type TodoStore } from "../src/todo/store.ts";
import { createTodoToolHandlers, TodoToolParams, type TodoToolCall } from "../src/todo/tools.ts";
import { registerCodexTodoCommands } from "../src/todo/commands.ts";
import { createTodoWidget } from "../src/todo/widget.ts";

const TODO_TOOL_NAME = "todo";

export default function codexTodoExtension(pi: ExtensionAPI): void {
  let store: TodoStore | undefined;
  let storeDir: string | undefined;
  let sessionCwd = process.cwd();
  let ui: { notify?: (text: string, type?: "info" | "warning" | "error") => void } | undefined;
  let turn = 0;
  const changedHooks: (() => void)[] = [];
  let lastSessionId = "main";

  const notify = (text: string, type?: "info" | "warning" | "error"): void => {
    try {
      ui?.notify?.(text, type);
    } catch {
      // notifying must never break a session
    }
  };

  const ensureStore = (cwd: string, session: string): TodoStore => {
    const dir = process.env.PI_CODEX_TODO_PATH ?? join(cwd, TODO_DIR_NAME);
    if (!store || storeDir !== dir) {
      store = openTodoStore(dir, { session });
      storeDir = dir;
      const status = store.status();
      if (status.recoveredFrom) {
        notify(`codex-todo: recovered from a corrupt state file (archived as ${status.recoveredFrom}) — run /todos-doctor`, "warning");
      }
      // Restart recovery reminder (pi-goal-x lesson: the model must KNOW the
      // list exists, with concrete numbers, or it ignores it).
      const open = store.read().tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
      if (open > 0) notify(`codex-todo: ${open} task(s) pending from the previous session — see /todos`);
    }
    return store;
  };

  const system = {
    get store(): TodoStore {
      if (!store) throw new Error("codex-todo: no active session (store not opened yet)");
      return store;
    },
    turn: () => turn,
    changed: (): void => {
      for (const hook of changedHooks) {
        try {
          hook();
        } catch {
          // a broken UI hook must not break the tool
        }
      }
    },
  };

  const widget = createTodoWidget({ system, sessionId: () => lastSessionId, truncateToWidth });
  changedHooks.push(() => widget.refresh());

  const releaseSession = (): void => {
    widget.detach();
    store?.dispose();
    store = undefined;
    storeDir = undefined;
    ui = undefined;
  };
  pi.on("session_shutdown", releaseSession);
  pi.on("session_start", (_event, ctx) => {
    releaseSession();
    ui = ctx.ui;
    sessionCwd = ctx.cwd;
    lastSessionId = ctx.sessionManager.getSessionId();
    turn = 0;
    try {
      ensureStore(ctx.cwd, lastSessionId);
      widget.attach(ctx.ui as never);
      widget.refresh();
    } catch (err) {
      notify(`codex-todo: failed to open store — ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    ui = ctx.ui;
    sessionCwd = ctx.cwd;
    try {
      ensureStore(ctx.cwd, ctx.sessionManager.getSessionId());
    } catch {
      // keep the previous store rather than spamming errors
    }
  });
  // Turn ordinal drives the widget's delayed completed-fold (and the panel's
  // disappearance once a list is fully done). pi's `input` event is the only
  // correct signal for "the user sent something", and EVERY submission counts —
  // a prompt, a steer typed while the agent still works, a queued follow-up:
  //   - `turn_start` fires per model round-trip, so rows would fold inside the
  //     request that completed them;
  //   - `ui_prompt_start` is pi's blocking-DIALOG event (ctx.ui.select/confirm/
  //     input), which chat input never fires — 0.19.4 fixes that wrong hook,
  //     which left the ordinal at 0 and kept old ✓ rows on screen forever.
  // The refresh re-evaluates visibility immediately, so rows fold on the next
  // message rather than on the next tool call.
  pi.on("input", () => {
    turn += 1;
    widget.refresh();
  });

  const handlers = createTodoToolHandlers(system, () => sessionCwd);
  try {
    pi.registerTool({
      name: TODO_TOOL_NAME,
      label: "Todo",
      description: [
        "Task list with subtask nesting, blockedBy dependencies and session claims, persisted to disk.",
        "Plan multi-step work as a tree: nest subtasks under their parent in the same add call (parentId).",
        "Keep the list current: claim before starting; complete each task once verified (evidence required, unfinished subtasks block the parent); skip superseded tasks with a reason.",
        "Before reporting done, run list and reconcile: nothing pending or in_progress, no parent left open.",
        "Adding to a FINISHED list starts a new list and paths restart at #1 — pass only new work, never reuse an earlier path; duplicate titles and illegal transitions are rejected with the reason, so read it and adjust.",
      ].join(" "),
      promptSnippet: "Add, update, claim, complete or inspect plan tasks",
      parameters: TodoToolParams,
      async execute(_toolCallId, params, _signal, _onUpdate, toolCtx) {
        const sessionId = toolCtx.sessionManager.getSessionId();
        return handlers(params as TodoToolCall, sessionId);
      },
    });
  } catch (err) {
    // Name collision (e.g. pi-agent-extensions' todos still enabled): say it
    // once, never spam. The store/commands still work for the user.
    notify(`codex-todo: tool "${TODO_TOOL_NAME}" unavailable — ${err instanceof Error ? err.message : String(err)} (disable the other todo extension)`, "warning");
  }

  // /todos restores a panel the user right-clicked away; the task list itself
  // prints as a text notify (the interactive overlay was removed in 0.17.5 —
  // the persistent panel plus the todo tool covered its use cases).
  const showPanel = (): void => {
    widget.show();
  };

  registerCodexTodoCommands(pi, { system, notify, showPanel });
}
