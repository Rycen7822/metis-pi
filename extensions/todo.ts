// codex-todo — pi extension entry. Wires the disk store, the model-facing
// todo tool, the user-facing commands, and lifecycle events. UI surfaces
// (persistent widget, fullscreen overlay) register themselves as changed
// hooks / overlay openers in their own modules (see src/todo/widget.ts,
// src/todo/overlay.ts).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
        notify(`codex-todo: recovered from a corrupt state file (archived as ${status.recoveredFrom}) — run /codex-todo-doctor`, "warning");
      }
      // Restart recovery reminder (pi-goal-x lesson: the model must KNOW the
      // list exists, with concrete numbers, or it ignores it).
      const open = store.read().tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
      if (open > 0) notify(`codex-todo: ${open} task(s) pending from the previous session — see /codex-todo`);
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

  const widget = createTodoWidget({ system, sessionId: () => lastSessionId });
  changedHooks.push(() => widget.refresh());

  try {
    pi.registerShortcut("ctrl+shift+t", {
      description: "Collapse/expand the codex-todo widget",
      handler: () => widget.toggleFold(),
    });
  } catch (err) {
    notify(`codex-todo: shortcut unavailable — ${err instanceof Error ? err.message : String(err)}`, "warning");
  }

  pi.on("session_start", (_event, ctx) => {
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
  // Turn ordinal drives the widget's delayed completed-fold. A new user
  // prompt advances the world even when no tool ran (pi-goal-x's lesson:
  // decide advancement by explicit signals, not by reading the transcript).
  pi.on("ui_prompt_start", () => {
    turn += 1;
  });

  const handlers = createTodoToolHandlers(system, () => sessionCwd);
  try {
    pi.registerTool({
      name: TODO_TOOL_NAME,
      label: "Todo",
      description: [
        "Task list with subtask nesting, blockedBy dependencies and session claims, persisted to disk.",
        "Guidance: claim before starting work; complete requires evidence and unfinished subtasks block completion;",
        "completed is one-way (reopen to reset); use addBlockedBy/removeBlockedBy incrementally, never resend whole lists;",
        "duplicate titles and illegal transitions are rejected with the reason — read the error and adjust instead of retrying.",
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

  registerCodexTodoCommands(pi, { system, notify });

  // M4 (overlay) attaches its opener here.
  void changedHooks;
}
