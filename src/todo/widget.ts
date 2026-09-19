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
// - Two sizes: the collapsed budget above, and an expanded view that shows the
//   whole list. A LEFT CLICK anywhere on the panel toggles between them (the
//   host dispatches mouse events through the layout tree, so the component just
//   implements handleMouse); ctrl+shift+t does the same for keyboards.
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
/** Collapsed height: header + up to 4 body rows (a "+N more" row counts). */
export const TODO_DEFAULT_MAX_LINES = 5;

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
  // The store opens at session_start, not at extension load — read the view
  // state lazily and default to the collapsed list until then.
  let expanded = (() => {
    try {
      return system.store.settings().widgetExpanded;
    } catch {
      return false;
    }
  })();
  let latchedHeight: number | null = null;

  /** Visible rows for the current snapshot (pure; also what tests assert). */
  function buildRows(state: TodoState, width: number, turn: number): Row[] {
    const count = (s: Task["status"]) => state.tasks.filter((t) => t.status === s).length;
    const done = count("complete") + count("skipped");

    // Delayed completed-fold: completions stay visible until the next turn.
    const visible = flattenTree(buildTree(state)).filter((n) => {
      const t = n.task;
      if (t.completedAtTurn != null && t.completedAtTurn < turn) return false;
      return true;
    });

    const anyBlockedBy = state.tasks.some((t) => t.blockedBy.length > 0);
    const session = deps.sessionId();
    const body: Row[] = [];
    for (const node of visible) {
      const t = node.task;
      const blocked = isBlocked(state, t.id);
      const glyph = blocked ? GLYPHS.blocked : t.status === "complete" ? GLYPHS.complete : t.status === "skipped" ? GLYPHS.skipped : t.status === "in_progress" ? GLYPHS.inProgress : GLYPHS.pending;
      const indent = "  ".repeat(node.depth - 1);
      const claim = t.claim ? (t.claim.session === session ? " · mine" : ` · ${t.claim.session}`) : "";
      const idPrefix = anyBlockedBy ? `${formatTaskId(t.id)} ` : "";
      body.push({ text: truncate(`${indent}${glyph} ${idPrefix}${t.title}${claim}`, width), tone: toneFor(t, blocked) });
    }
    // Overflow policy: completed first, then the pending tail; one summary row
    // that shares the budget with the rows it summarizes. Expanded shows
    // everything, so nothing is dropped there.
    const room = expanded ? body.length : maxLines - 1; // header always shows
    let overflowDone = 0;
    let overflowPending = 0;
    let shown = body;
    if (body.length > room) {
      const capacity = Math.max(0, room - 1); // one slot belongs to the summary
      const doneIdx: number[] = [];
      const liveIdx: number[] = [];
      body.forEach((r, i) => (r.tone === "success" || r.tone === "dim" ? doneIdx : liveIdx).push(i));
      // Keep every pending row that fits, then the newest completed ones; the
      // surviving rows keep their tree order.
      const keepLive = new Set(liveIdx.slice(0, capacity));
      const keepDone = new Set(doneIdx.slice(Math.max(0, doneIdx.length - Math.max(0, capacity - keepLive.size))));
      const keep = new Set([...keepLive, ...keepDone]);
      overflowDone = doneIdx.filter((i) => !keep.has(i)).length;
      overflowPending = liveIdx.filter((i) => !keep.has(i)).length;
      shown = body.filter((_, i) => keep.has(i));
    }
    const overflow = overflowDone + overflowPending;
    const hint = expanded ? " ▴ · click to collapse" : overflow > 0 ? " ▾ · click to expand" : "";
    const rows: Row[] = [
      { text: truncate(`Todos ${done}/${state.tasks.length} done${hint}`, width), tone: "accent" },
      ...shown,
    ];
    if (overflow > 0) {
      rows.push({
        text: truncate(`+${overflow} more (${overflowDone} completed, ${overflowPending} pending)`, width),
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
    // Stable-height latch: fix the count at first sight and pad later, so live
    // updates never shrink the panel under the user. Growth is allowed (new
    // tasks, an explicit expand) because buildRows already bounds the height.
    if (latchedHeight == null) latchedHeight = lines.length;
    else if (lines.length > latchedHeight) latchedHeight = lines.length;
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

  function setExpanded(next: boolean): void {
    expanded = next;
    // Re-latch: the panel is allowed to change size when the user asks for it.
    latchedHeight = null;
    try {
      system.store.saveSettings({ widgetExpanded: expanded });
    } catch {
      // persistence is best-effort; the toggle still works in-memory
    }
    refresh();
  }

  function toggleExpanded(): void {
    setExpanded(!expanded);
  }

  const factory = (tui: unknown, theme: TodoWidgetTheme | undefined) => {
    tuiRef = tui as { requestRender?: () => void } | undefined;
    return {
      render(width: number): string[] {
        return paint(buildRows(system.store.read(), width, system.turn()), theme);
      },
      // The host hit-tests the layout and calls handleMouse on the component
      // under the cursor, so a left click anywhere on the panel toggles the
      // full list. Claiming the event keeps it away from transcript selection.
      handleMouse(event?: { type?: string; button?: string }): { handled: true } | undefined {
        if (event?.type !== "click" || event?.button !== "left") return undefined;
        toggleExpanded();
        return { handled: true };
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
    toggleExpanded,
    isExpanded: () => expanded,
    /** Test seam: the widget component the host sees (render + handleMouse). */
    component: (tui: unknown, theme?: TodoWidgetTheme) => factory(tui, theme) as {
      render(width: number): string[];
      handleMouse?(event: { type?: string; button?: string }): unknown;
    },
    /** changed-hook entry point — re-evaluate visibility, render if shown. */
    refresh,
    /** Test seam: raw rows without colors or latching. */
    buildRows,
    visibleRows,
  };
}

export type TodoWidget = ReturnType<typeof createTodoWidget>;
