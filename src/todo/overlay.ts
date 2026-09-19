// codex-todo — fullscreen overlay. The interactive companion to the widget:
// same store, different renderer (pi-goal-x's separation rule). Host contract:
// ctx.ui.custom(factory, {overlay: true, overlayOptions}) hands the factory a
// KeybindingsManager, so navigation uses the user's named keybindings
// (pi-agent-extensions' getKeybindings pattern); action keys are plain
// letters compared directly.

import { buildTree, claimTask, completeTask, flattenTree, formatTaskId, isBlocked, releaseTask, skipTask, transitionTask, type TodoState } from "./model.ts";
import type { CodexTodoSystem } from "./tools.ts";

export interface TodoOverlayUi {
  custom<T>(factory: (tui: unknown, theme: unknown, keybindings: TodoOverlayKeybindings, done: (result: T) => void) => {
    render(width: number): string[];
    handleInput?(data: string): void;
    dispose?(): void;
  }, options?: { overlay?: boolean; overlayOptions?: { width?: string; maxHeight?: string; anchor?: string } }): Promise<T>;
}

export interface TodoOverlayKeybindings {
  matches?(data: string, name: string): boolean;
}

export interface TodoOverlayDeps {
  system: CodexTodoSystem;
  sessionId: () => string;
  now?: () => number;
}

interface OverlayRow {
  id: number;
  depth: number;
  text: string;
  tone: "accent" | "success" | "warning" | "dim" | "normal";
}

const HELP = "↑↓ move · space progress · s skip · r reopen · x claim/release · Esc close";

/** Pure row builder — the test seam. Always shows ids (unlike the widget). */
export function buildOverlayRows(state: TodoState, sessionId: string, cursor: number, width: number): OverlayRow[] {
  const flat = flattenTree(buildTree(state));
  const rows: OverlayRow[] = [{
    id: -1, depth: 0,
    text: `── todos (${state.tasks.length} tasks) ${"─".repeat(Math.max(0, width - 24))}`.slice(0, width),
    tone: "accent",
  }];
  if (flat.length === 0) {
    rows.push({ id: -1, depth: 0, text: "(no tasks — close with Esc and ask the agent to plan)", tone: "dim" });
  }
  flat.forEach((node, i) => {
    const t = node.task;
    const blocked = isBlocked(state, t.id);
    const glyph = blocked ? "⚠︎" : t.status === "complete" ? "✓" : t.status === "skipped" ? "✗" : t.status === "in_progress" ? "◐" : "○";
    const claim = t.claim ? (t.claim.session === sessionId ? " · mine" : ` · ${t.claim.session}`) : "";
    const skip = t.status === "skipped" && t.skipReason ? ` — ${t.skipReason}` : "";
    const ev = t.status === "complete" && t.evidence ? `  ⟨${t.evidence}⟩` : "";
    const cursorMark = i === cursor ? "❯" : " ";
    rows.push({
      id: t.id,
      depth: node.depth,
      text: `${cursorMark} ${"  ".repeat(node.depth - 1)}${glyph} ${formatTaskId(t.id)} ${t.title}${claim}${skip}${ev}`.slice(0, width),
      tone: blocked ? "warning" : t.status === "complete" ? "success" : t.status === "skipped" ? "dim" : t.status === "in_progress" ? "accent" : "normal",
    });
  });
  rows.push({ id: -1, depth: 0, text: HELP.slice(0, width), tone: "dim" });
  return rows;
}

export function openTodoOverlay(ui: TodoOverlayUi, deps: TodoOverlayDeps): Promise<void> {
  const { system } = deps;
  const now = deps.now ?? Date.now;
  let cursor = 0;
  let tuiRef: { requestRender?: () => void } | undefined;

  const mutate = async (fn: () => Promise<unknown> | unknown): Promise<void> => {
    try {
      await fn();
      system.changed();
    } catch (err) {
      // Surface as a transient footer line instead of crashing the overlay.
      flash = err instanceof Error ? err.message : String(err);
    }
    tuiRef?.requestRender?.();
  };
  let flash: string | null = null;

  return ui.custom<"closed">((tui, _theme, kb, done) => {
    tuiRef = tui as { requestRender?: () => void } | undefined;
    return {
    render(width: number): string[] {
      const rows = buildOverlayRows(system.store.read(), deps.sessionId(), cursor, width);
      const lines = rows.map((r) => r.text);
      if (flash) {
        lines.push(flash.slice(0, width));
        flash = null;
      }
      return lines;
    },
    handleInput(data: string): void {
      const state = system.store.read();
      const flat = flattenTree(buildTree(state));
      const up = kb?.matches?.(data, "tui.select.up") ?? data === "\x1b[A";
      const down = kb?.matches?.(data, "tui.select.down") ?? data === "\x1b[B";
      if (up) {
        cursor = Math.max(0, cursor - 1);
        tuiRef?.requestRender?.();
        return;
      }
      if (down) {
        cursor = Math.min(Math.max(0, flat.length - 1), cursor + 1);
        tuiRef?.requestRender?.();
        return;
      }
      if (data === "\x1b" || data === "q") {
        done("closed");
        return;
      }
      const node = flat[cursor];
      if (!node) return;
      const id = node.task.id;
      const session = deps.sessionId();
      void mutate(async () => {
        const current = () => system.store.read().tasks.find((x) => x.id === id);
        switch (data) {
          case " ": {
            const t = current();
            if (!t) return;
            if (t.status === "pending") {
              const r = await system.store.mutate((s) => transitionTask(s, id, "in_progress", now()));
              if (!r.ok) throw new Error(r.error);
            } else if (t.status === "in_progress") {
              // User-driven completion from the overlay: the gate still runs
              // (unfinished subtasks block), evidence marks WHO completed it.
              const r = await system.store.mutate((s) => completeTask(s, id, "completed via /todos overlay", now(), system.turn()));
              if (!r.ok) throw new Error(r.error);
            }
            break;
          }
          case "s": {
            const r = await system.store.mutate((s) => skipTask(s, id, "skipped from overlay", now()));
            if (!r.ok) throw new Error(r.error);
            break;
          }
          case "r": {
            const r = await system.store.mutate((s) => transitionTask(s, id, "pending", now()));
            if (!r.ok) throw new Error(r.error);
            break;
          }
          case "x": {
            const t = current();
            if (!t) return;
            if (t.claim && t.claim.session === session) {
              const r = await system.store.mutate((s) => releaseTask(s, id, session, now()));
              if (!r.ok) throw new Error(r.error);
            } else if (!t.claim) {
              const r = await system.store.mutate((s) => claimTask(s, id, session, now()));
              if (!r.ok) throw new Error(r.error);
            } else {
              throw new Error(`${formatTaskId(id)} is claimed by ${t.claim.session} (use the todo tool with force)`);
            }
            break;
          }
          default:
            break;
        }
      });
    },
    dispose(): void {
      // nothing held
    },
    };
  }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } }).then(() => undefined);
}
