// codex-todo — persistent above-editor widget. Engineering rules from
// rpiv-todo and pi-goal-x (docs/0.16.0-todo-plugin-plan.md):
// - setWidget register-once: a `widgetRegistered` bool owns the lifecycle;
//   zero content → setWidget(key, undefined). dispose() unregisters first.
// - The registered factory is a GETTER CLOSURE: the host re-invokes it per
//   frame, and each call reads the CURRENT store snapshot (pi-goal-x's
//   factory-vs-value lesson — never capture state at registration time).
// - Stable-height latch: the first visible frame fixes the line count; later
//   frames pad with blanks and never shrink, so the terminal never jumps.
// - Line budget is a pure function: maxLines − 1 header; overflow costs one
//   more row for a "+N more" summary; completed rows are dropped first.
// - Completed rows collapse on the NEXT turn (completedAtTurn < turn), so the
//   user sees the ✓ before it folds away.
// - Zero polling: refresh() runs only from the system's changed hook.
//
// The widget takes no pi-tui dependency: the host hands (tui, theme) to the
// factory, and the component contract is just { render(width): string[] }.

import { buildTree, flattenTree, formatTaskId, isBlocked, type Task, type TodoState } from "./model.ts";
import type { CodexTodoSystem } from "./tools.ts";

export const TODO_WIDGET_KEY = "codex-todo";
export const TODO_WIDGET_PLACEMENT = "aboveEditor";
export const TODO_DEFAULT_MAX_LINES = 4;

export interface TodoWidgetTheme {
  fg?: (kind: string, text: string) => string;
}

export interface TodoWidgetUi {
  setWidget(key: string, content: ((tui: unknown, theme: TodoWidgetTheme | undefined) => unknown) | undefined, options?: { placement?: string }): void;
}

export interface TodoWidgetDeps {
  system: CodexTodoSystem;
  sessionId: () => string;
  maxLines?: number;
}

interface Row {
  text: string;
  tone: "accent" | "success" | "warning" | "dim" | "normal";
}

const GLYPHS = { pending: "○", inProgress: "◐", complete: "✓", skipped: "✗", blocked: "⚠︎" } as const;

const truncate = (text: string, width: number): string => {
  if (width <= 0) return "";
  const chars = [...text];
  if (chars.length <= width) return text;
  return chars.slice(0, Math.max(0, width - 1)).join("") + "…";
};

const toneFor = (task: Task, blocked: boolean): Row["tone"] => {
  if (blocked) return "warning";
  if (task.status === "complete") return "success";
  if (task.status === "skipped") return "dim";
  if (task.status === "in_progress") return "accent";
  return "normal";
};

export function createTodoWidget(deps: TodoWidgetDeps) {
  const { system } = deps;
  const maxLines = Math.max(3, deps.maxLines ?? TODO_DEFAULT_MAX_LINES);
  let ui: TodoWidgetUi | undefined;
  let tuiRef: { requestRender?: () => void } | undefined;
  let widgetRegistered = false;
  // The store opens at session_start, not at extension load — read the fold
  // state lazily and default to unfolded until then.
  let folded = (() => {
    try {
      return system.store.settings().widgetFolded;
    } catch {
      return false;
    }
  })();
  let latchedHeight: number | null = null;

  /** Visible rows for the current snapshot (pure; also what tests assert). */
  function buildRows(state: TodoState, width: number, turn: number): Row[] {
    const count = (s: Task["status"]) => state.tasks.filter((t) => t.status === s).length;
    const done = count("complete") + count("skipped");
    const header: Row = {
      text: truncate(`Todos ${done}/${state.tasks.length} done${folded ? " ▸" : " ▾"} · ctrl+shift+t`, width),
      tone: "accent",
    };
    if (folded) return [header];

    // Delayed completed-fold: completions stay visible until the next turn.
    const visible = flattenTree(buildTree(state)).filter((n) => {
      const t = n.task;
      if (t.completedAtTurn != null && t.completedAtTurn < turn) return false;
      return true;
    });

    const rows: Row[] = [header];
    const anyBlockedBy = state.tasks.some((t) => t.blockedBy.length > 0);
    const session = deps.sessionId();
    const body: Row[] = [];
    let overflowDone = 0;
    let overflowPending = 0;
    const budget = maxLines - 1; // header always shows
    for (const node of visible) {
      const t = node.task;
      const blocked = isBlocked(state, t.id);
      const glyph = blocked ? GLYPHS.blocked : t.status === "complete" ? GLYPHS.complete : t.status === "skipped" ? GLYPHS.skipped : t.status === "in_progress" ? GLYPHS.inProgress : GLYPHS.pending;
      const indent = "  ".repeat(node.depth - 1);
      const claim = t.claim ? (t.claim.session === session ? " · mine" : ` · ${t.claim.session}`) : "";
      const idPrefix = anyBlockedBy ? `${formatTaskId(t.id)} ` : "";
      body.push({ text: truncate(`${indent}${glyph} ${idPrefix}${t.title}${claim}`, width), tone: toneFor(t, blocked) });
    }
    // Overflow policy: completed first, then the pending tail; one summary row.
    let room = budget;
    let summaryNeeded = false;
    if (body.length > room) {
      const kept: typeof body = [];
      const doneRows = body.filter((r) => r.tone === "success" || r.tone === "dim");
      const liveRows = body.filter((r) => r.tone !== "success" && r.tone !== "dim");
      const dropDone = Math.max(0, body.length - room);
      const keptDone = doneRows.slice(Math.max(0, dropDone));
      overflowDone = doneRows.length - keptDone.length;
      const keptLive = liveRows.slice(0, Math.max(0, room - keptDone.length));
      overflowPending = liveRows.length - keptLive.length;
      kept.push(...keptDone, ...keptLive);
      summaryNeeded = overflowDone + overflowPending > 0;
      body.length = 0;
      body.push(...kept);
      if (summaryNeeded && body.length >= room) body.pop();
    }
    rows.push(...body);
    if (summaryNeeded) {
      rows.push({
        text: truncate(`+${overflowDone + overflowPending} more (${overflowDone} completed, ${overflowPending} pending)`, width),
        tone: "dim",
      });
    }
    // Trailing spacer keeps the panel off the editor (rpiv's rule).
    rows.push({ text: "", tone: "normal" });
    return rows;
  }

  /** Should the widget exist at all right now? */
  function visibleRows(state: TodoState, turn: number): boolean {
    if (state.tasks.length === 0) return false;
    const unfinished = state.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
    if (unfinished) return true;
    // Everything finished: linger until this turn's completions fold away.
    return state.tasks.some((t) => t.completedAtTurn != null && t.completedAtTurn >= turn);
  }

  const paint = (rows: Row[], theme: TodoWidgetTheme | undefined): string[] => {
    let lines = rows.map((r) => r.text);
    // Stable-height latch: fix the count at first sight, pad later, never shrink.
    if (latchedHeight == null) latchedHeight = lines.length;
    else if (lines.length > latchedHeight) latchedHeight = Math.min(lines.length, maxLines + 1);
    while (lines.length < latchedHeight) lines.push("");
    if (lines.length > latchedHeight) lines = lines.slice(0, latchedHeight);
    return lines.map((line, i) => {
      const tone = rows[i]?.tone ?? "normal";
      if (!line || tone === "normal") return line;
      try {
        return typeof theme?.fg === "function" ? theme.fg(tone, line) : line;
      } catch {
        return line;
      }
    });
  };

  const factory = (tui: unknown, theme: TodoWidgetTheme | undefined) => {
    tuiRef = tui as { requestRender?: () => void } | undefined;
    return {
      render(width: number): string[] {
        return paint(buildRows(system.store.read(), width, system.turn()), theme);
      },
    };
  };

  const unregister = (): void => {
    if (!widgetRegistered) return;
    try {
      ui?.setWidget(TODO_WIDGET_KEY, undefined);
    } catch {
      // unregister must never throw
    }
    widgetRegistered = false;
  };

  const refresh = (): void => {
    if (!ui) return;
    let state: TodoState;
    try {
      state = system.store.read();
    } catch {
      return;
    }
    if (!visibleRows(state, system.turn())) {
      unregister();
      return;
    }
    if (!widgetRegistered) {
      try {
        ui.setWidget(TODO_WIDGET_KEY, factory, { placement: TODO_WIDGET_PLACEMENT });
        widgetRegistered = true;
      } catch {
        return;
      }
    } else {
      try {
        tuiRef?.requestRender?.();
      } catch {
        // render-on-next-frame is enough; the factory re-reads on render
      }
    }
  };

  return {
    attach(widgetUi: TodoWidgetUi): void {
      ui = widgetUi;
    },
    detach(): void {
      unregister();
      ui = undefined;
      tuiRef = undefined;
      latchedHeight = null;
    },
    toggleFold(): void {
      folded = !folded;
      try {
        system.store.saveSettings({ widgetFolded: folded });
      } catch {
        // persistence is best-effort; the toggle still works in-memory
      }
      refresh();
    },
    isFolded: () => folded,
    /** changed-hook entry point — re-evaluate visibility, render if shown. */
    refresh,
    /** Test seam: raw rows without colors or latching. */
    buildRows,
    visibleRows,
  };
}

export type TodoWidget = ReturnType<typeof createTodoWidget>;
