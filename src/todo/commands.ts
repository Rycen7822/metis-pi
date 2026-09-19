// codex-todo — user-facing commands. Kept apart from tools.ts: commands speak
// to the USER (notify/overlay), tools speak to the MODEL.

import { type TodoState } from "./model.ts";
import type { TodoStore } from "./store.ts";
import { renderListText, type CodexTodoSystem } from "./tools.ts";

export interface CodexTodoCommandsDeps {
  system: CodexTodoSystem;
  notify(text: string, type?: "info" | "warning" | "error"): void;
  /** Open the fullscreen overlay; undefined when the host has no TUI. */
  openOverlay?: () => void;
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
    description: "Show the codex-todo task list (overlay when a TUI is available)",
    handler: (_args, ctx) => {
      const { system, openOverlay } = deps;
      const state = system.store.read();
      if (openOverlay && state.tasks.length > 0) {
        openOverlay();
        return;
      }
      if (state.tasks.length === 0) {
        (ctx.ui?.notify ?? deps.notify)("codex-todo: no tasks yet — ask the agent to plan with the todo tool");
        return;
      }
      (ctx.ui?.notify ?? deps.notify)(renderListText(state, "user"));
    },
  });

  api.registerCommand("todos-doctor", {
    description: "codex-todo: read-only diagnostics (corrupt archives, stale locks, GC)",
    handler: (args, ctx) => {
      const notify = ctx.ui?.notify ?? deps.notify;
      const store: TodoStore = deps.system.store;
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

export type { TodoState };
