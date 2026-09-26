// codex-todo — user-facing commands. Kept apart from tools.ts: commands speak
// to the USER (notify), tools speak to the MODEL. The interactive overlay was
// removed in 0.17.5 — /todos prints the list as text and restores the panel.

import type { TodoStore } from "./store.ts";
import { renderListText } from "./tools.ts";

export interface CodexTodoCommandsDeps {
  system: { store: Pick<TodoStore, "read" | "status" | "collect"> };
  notify(text: string, type?: "info" | "warning" | "error"): void;
  /** Restore the persistent panel when the user hid it with a right click. */
  showPanel?: () => void;
}

export function registerCodexTodoCommands(pi: unknown, deps: CodexTodoCommandsDeps): void {
  const api = pi as {
    registerCommand?: (name: string, options: {
      description: string;
      handler: (args: string, ctx: { ui?: { notify?: (t: string, type?: "info" | "warning" | "error") => void } }) => void | Promise<void>;
    }) => void;
  };
  if (typeof api.registerCommand !== "function") return;

  api.registerCommand("todos", {
    description: "Show the codex-todo task list (and restore the panel)",
    handler: (_args, ctx) => {
      const state = deps.system.store.read();
      deps.showPanel?.();
      const notify = ctx.ui?.notify ?? deps.notify;
      if (state.tasks.length === 0) {
        notify("codex-todo: no tasks yet — ask the agent to plan with the todo tool");
        return;
      }
      notify(renderListText(state, "user"));
    },
  });

  api.registerCommand("todos-doctor", {
    description: "codex-todo: read-only diagnostics (corrupt archives, stale locks, GC)",
    handler: (args, ctx) => {
      const notify = ctx.ui?.notify ?? deps.notify;
      const store = deps.system.store;
      const status = store.status();
      const lines = [
        `codex-todo doctor (${status.dir})`,
        `  state file: ${status.stateFile ? "ok" : "missing (empty store)"} · tasks: ${status.taskCount}`,
        `  gcDays: ${status.settings.gcDays}`,
        `  lock: ${status.lock.held ? `held by ${status.lock.info?.session ?? "unknown"}${status.lock.stale ? " (STALE)" : ""}` : "free"}`,
        `  archived artifacts: ${status.backups.length > 0 ? status.backups.join(", ") : "none"}`,
      ];
      const want = args.trim().toLowerCase();
      if (want === "gc") {
        const removed = store.collect();
        lines.push(removed > 0 ? `  gc: removed ${removed} completed task(s)` : "  gc: nothing eligible");
      } else if (want.length > 0 && want !== "status") {
        lines.push("  (unknown argument — use: doctor, doctor gc, or doctor status)");
      }
      notify(lines.join("\n"));
    },
  });
}
