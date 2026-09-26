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
//   implements handleMouse). A RIGHT CLICK hides the panel altogether; opening
//   /todos shows it again. The hide is persisted (`widgetHidden`) so it survives
//   restarts. No keyboard shortcut: interaction is mouse-only by design.
// - Completed rows collapse on the NEXT turn (completedAtTurn < turn), so the
//   user sees the ✓ before it folds away.
// - Zero polling: refresh() runs only from the system's changed hook.
//
// The widget takes no pi-tui dependency: the host hands (tui, theme) to the
// factory, and the component contract is just { render(width): string[] }.

import { taskRows, isBlocked, taskGlyph, taskPaths, type Task, type TodoState } from "./model.ts";
import type { TodoStore } from "./store.ts";

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
  system: {
    store: Pick<TodoStore, "snapshot" | "settings" | "saveSettings">;
    turn(): number;
  };
  sessionId: () => string;
  /** Native terminal-column truncation supplied by the Pi entry. */
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
  maxLines?: number;
}

interface Row {
  text: string;
  tone: "accent" | "success" | "warning" | "dim" | "normal";
}

const toneFor = (task: Task, blocked: boolean): Row["tone"] => {
  if (blocked) return "warning";
  if (task.status === "complete") return "success";
  if (task.status === "skipped") return "dim";
  if (task.status === "in_progress") return "accent";
  return "normal";
};

export interface TodoRowOptions {
  width: number;
  turn: number;
  sessionId: string;
  expanded: boolean;
  maxLines: number;
}

/** Visible rows for the current snapshot (pure; also what tests assert). */
export function buildTodoRows(
  state: TodoState,
  options: TodoRowOptions,
  truncateToWidth: (text: string, width: number, ellipsis?: string) => string,
): Row[] {
  const { width, turn, sessionId, expanded, maxLines } = options;
  const truncate = (text: string, width: number) => truncateToWidth(text, width, "…");
  const count = (s: Task["status"]) => state.tasks.filter((t) => t.status === s).length;
  const done = count("complete") + count("skipped");

  // Delayed completed-fold: completions stay visible until the next turn.
  const visible = taskRows(state).filter((n) => {
    const t = n.task;
    if (t.completedAtTurn != null && t.completedAtTurn < turn) return false;
    return true;
  });

  const anyBlockedBy = state.tasks.some((t) => t.blockedBy.length > 0);
  const paths = anyBlockedBy ? taskPaths(state) : null;
  const body: Row[] = [];
  for (const node of visible) {
    const t = node.task;
    const blocked = isBlocked(state, t.id);
    const glyph = taskGlyph(t, blocked);
    const indent = "  ".repeat(node.depth - 1);
    const claim = t.claim ? (t.claim.session === sessionId ? " · mine" : ` · ${t.claim.session}`) : "";
    const idPrefix = paths ? `${paths.get(t.id)} ` : "";
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

export function createTodoWidget(deps: TodoWidgetDeps) {
  const { system } = deps;
  const truncate = (text: string, width: number) => deps.truncateToWidth(text, width, "…");
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
  // User-level hide: while set the panel stays gone regardless of tasks.
  // Lazily read like `expanded` — the store opens at session_start.
  let hidden = (() => {
    try {
      return system.store.settings().widgetHidden;
    } catch {
      return false;
    }
  })();
  // Session boundary for the completed-fold: ms epoch stamped when the panel
  // attaches (session_start). 0 before that, so a pure visibleRows() call keeps
  // the turn-only rule. See visibleRows() for why the boundary exists.
  let attachedAt = 0;
  let latchedHeight: number | null = null;
  // Shared across factory invocations: the host may recreate the component
  // each frame. Cache raw rows, not theme-painted strings.
  let cachedRows: { state: TodoState; width: number; turn: number; session: string; expanded: boolean; rows: Row[] } | undefined;

  /** Should the widget exist at all right now? */
  function visibleRows(state: TodoState, turn: number): boolean {
    if (state.tasks.length === 0) return false;
    const unfinished = state.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
    if (unfinished) return true;
    // Everything finished: linger until this turn's completions fold away — but
    // only for completions THIS session watched happen. The store is per
    // workspace and survives restarts while `turn` restarts at 0, so without the
    // timestamp gate every old completion looks like it happened "this turn" and
    // an all-done panel pops up again on startup (0.19.1).
    return state.tasks.some(
      (t) =>
        t.completedAtTurn != null && t.completedAtTurn >= turn && t.completedAt != null && t.completedAt >= attachedAt,
    );
  }

  const paint = (rows: Row[], theme: TodoWidgetTheme | undefined): string[] => {
    let lines = rows.map((r) => r.text);
    // Stable-height latch: fix the count at first sight and pad later, so live
    // updates never shrink the panel under the user. Growth is allowed (new
    // tasks, an explicit expand) because buildTodoRows already bounds the height.
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

  function setHidden(next: boolean): void {
    hidden = next;
    latchedHeight = null;
    try {
      system.store.saveSettings({ widgetHidden: hidden });
    } catch {
      // persistence is best-effort; the toggle still works in-memory
    }
    refresh();
  }

  const factory = (tui: unknown, theme: TodoWidgetTheme | undefined) => {
    tuiRef = tui as { requestRender?: () => void } | undefined;
    return {
      render(width: number): string[] {
        let state: TodoState;
        try {
          state = system.store.snapshot();
        } catch {
          cachedRows = undefined;
          // Keep display failures distinct from empty/stale tasks. Retry the
          // snapshot on the next render rather than caching the error row.
          return paint([{ text: truncate("Todos unavailable", width), tone: "warning" }], theme);
        }
        const turn = system.turn();
        const session = deps.sessionId();
        if (!cachedRows || cachedRows.state !== state || cachedRows.width !== width
          || cachedRows.turn !== turn || cachedRows.session !== session || cachedRows.expanded !== expanded) {
          cachedRows = { state, width, turn, session, expanded, rows: buildTodoRows(state, { width, turn, sessionId: session, expanded, maxLines }, deps.truncateToWidth) };
        }
        return paint(cachedRows.rows, theme);
      },
      // Host contract (pi-tui handleMouseEvent): claiming a press makes the host
      // remember this component as the press target and expect its release —
      // but Warp forwards a right press and then EATS the release (its context
      // menu takes it), which would leave a stale press target swallowing later
      // clicks. So hide ON the press and deliberately do NOT claim it: the side
      // effect already happened, and an unclaimed right press costs nothing
      // (no other component claims right presses; selection ignores them).
      handleMouse(event?: { type?: string; button?: string }): { handled: true } | undefined {
        if (event?.type === "press" && event.button === "right") {
          setHidden(true);
          return undefined;
        }
        if (event?.type === "click" && event.button === "left") {
          toggleExpanded();
          return { handled: true };
        }
        return undefined;
      },
    };
  };

  const unregister = (): void => {
    cachedRows = undefined;
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
    if (hidden) {
      unregister();
      return;
    }
    let state: TodoState;
    try {
      state = system.store.snapshot();
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
      attachedAt = Date.now();
      cachedRows = undefined;
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
    setHidden,
    hide: () => setHidden(true),
    show: () => setHidden(false),
    isHidden: () => hidden,
    /** Test seam: the widget component the host sees (render + handleMouse). */
    component: (tui: unknown, theme?: TodoWidgetTheme) => factory(tui, theme) as {
      render(width: number): string[];
      handleMouse?(event: { type?: string; button?: string }): unknown;
    },
    /** changed-hook entry point — re-evaluate visibility, render if shown. */
    refresh,
    visibleRows,
  };
}

export type TodoWidget = ReturnType<typeof createTodoWidget>;
