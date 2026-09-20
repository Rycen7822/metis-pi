// codex-todo — task model. Pure functions only: no fs, no pi, no time source
// beyond injected `now`. The store (store.ts) owns persistence and locking;
// tools.ts owns LLM-facing policy on top of these primitives.
//
// Design sources (see docs/0.16.0-todo-plugin-plan.md):
// - 4-state machine (pending|in_progress|complete|skipped): parallel subagents
//   mean several tasks can be live at once, so a single currentTask pointer
//   (pi-goal-x) cannot express our case; claimed ⇒ in_progress per transition
//   table below.
// - Explicit VALID_TRANSITIONS table + "illegal transition X → Y" errors that
//   name states, so the model can self-correct (rpiv-todo invariants.ts).
// - Flat [{title, parentId?}] input, extension builds the tree (pi-goal-x).
// - Parent display state DERIVED from children at render time, never stored
//   (pi-goal-x derive) — one fact, one place.
// - complete is one-way except reopen (rpiv), and completion is GATED on the
//   subtree + evidence (pi-goal-x policy, default block).

export type TaskStatus = "pending" | "in_progress" | "complete" | "skipped";

export interface Task {
  id: number;
  title: string;
  parentId: number | null;
  status: TaskStatus;
  /** Tasks that must be complete before this one is sensible to start. */
  blockedBy: number[];
  /** Owning session (subagent claim); long-lived, distinct from store locks. */
  claim: { session: string; at: number } | null;
  /** Untrusted executor claim, recorded at completion (pi-goal-x). */
  evidence: string | null;
  skipReason: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Turn ordinal at completion; drives the widget's delayed completed-fold. */
  completedAtTurn: number | null;
}

export interface TodoState {
  version: 1;
  nextId: number;
  tasks: Task[];
}

export const TODO_SCHEMA_VERSION = 1 as const;
export const MAX_TASKS = 15;
export const MAX_DEPTH = 4;
/** Internal identity of a task. NEVER shown to the user or the model — use
 * `taskPaths`/`pathOf` for anything that leaves the store. */
export const formatTaskId = (id: number): string => `#${id}`;

// ---------------------------------------------------------------------------
// Task references — what the user and the model see.
//
// A task is identified by its HIERARCHICAL PATH: roots count from 1 in list
// order, and each level appends its position among its siblings, so a subtask is
// `#1.2` and its child `#1.2.1`. Numbering restarts with every new list, which
// keeps the panel readable (a list is a plan, not a session-long ledger) at the
// cost of ids being unique only WITHIN one list: `add` reports the restart
// loudly, and a reference that no longer resolves names the paths that do.

export interface TaskRef {
  ok: true;
  id: number;
}
export interface TaskRefError {
  ok: false;
  error: string;
}

/** Map of internal id → display path (`#1`, `#1.2`, …) for the current list. */
export function taskPaths(state: TodoState): Map<number, string> {
  const children = new Map<number | null, Task[]>();
  for (const task of state.tasks) {
    const key = task.parentId ?? null;
    const siblings = children.get(key);
    if (siblings) siblings.push(task);
    else children.set(key, [task]);
  }
  const paths = new Map<number, string>();
  const walk = (parent: number | null, prefix: string): void => {
    const siblings = children.get(parent) ?? [];
    siblings.forEach((task, index) => {
      const path = prefix === "" ? String(index + 1) : `${prefix}.${index + 1}`;
      paths.set(task.id, `#${path}`);
      walk(task.id, path);
    });
  };
  walk(null, "");
  // Defensive: a task whose parent is missing (corrupt store) still gets a
  // label — never the internal id, which must not reach the screen.
  let orphan = 0;
  for (const task of state.tasks) {
    if (!paths.has(task.id)) paths.set(task.id, `#?${++orphan}`);
  }
  return paths;
}

/** Display path of one task in this state. */
export function pathOf(state: TodoState, id: number): string {
  return taskPaths(state).get(id) ?? formatTaskId(id);
}

/**
 * Resolve a user/model-supplied reference (`"1"`, `"#1.2"`, or a legacy number)
 * to an internal id. Errors name every path that DOES exist, so a stale or
 * shifted reference self-corrects instead of silently hitting another task.
 */
export function resolveTaskRef(state: TodoState, ref: string | number): TaskRef | TaskRefError {
  const raw = String(ref).trim().replace(/^#/, "");
  if (!/^\d+(\.\d+)*$/.test(raw)) {
    return { ok: false, error: `bad task reference "${String(ref)}" — use a path like #1 or #1.2` };
  }
  const wanted = `#${raw}`;
  for (const [id, path] of taskPaths(state)) {
    if (path === wanted) return { ok: true, id };
  }
  const known = [...taskPaths(state).values()].join(", ") || "none";
  return { ok: false, error: `task ${wanted} not found — current paths: ${known}` };
}

// ---------------------------------------------------------------------------
// Text hygiene — model-generated text crosses the TUI boundary; keep control
// sequences and bidi marks out of titles (rpiv-todo tool/sanitize.ts).
// Strip in passes: OSC/DCS-style strings first (they can contain CSI-lookalike
// bytes), then CSI, then any remaining ESC-introduced sequence.

const OSC_SEQUENCE = /[\u001B\u009B\u007F]][\s\S]*?(?:\u0007|\u001B\\)/g; // ESC ] … (BEL | ESC \)
const DCS_SEQUENCE = /\u001B[PX^_][\s\S]*?\u001B\\/g; // DCS/SOS/PM/APC … terminated by ESC \
const CSI_SEQUENCE = /[\u001B\u009B]\[[0-?]*[ -/]*[@-~]/g;
const ESCAPE_INTRODUCER = /\u001B[@-_]/g; // any leftover ESC + optional intermediate + final
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeText(text: string): string {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(DCS_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESCAPE_INTRODUCER, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// State machine

export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["in_progress", "skipped"],
  in_progress: ["pending", "complete", "skipped"],
  skipped: ["pending"],
  complete: ["pending"],
};

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  VALID_TRANSITIONS[from].includes(to);

export const transitionError = (id: number, from: TaskStatus, to: TaskStatus): string =>
  `illegal transition ${formatTaskId(id)}: ${from} → ${to} (allowed: ${VALID_TRANSITIONS[from].join(", ") || "none — use reopen to reset"})`;

/** Status glyphs shared by the panel (TUI columns) and `todos` (plain text). */
export const TASK_GLYPHS = { pending: "○", inProgress: "◐", complete: "✓", skipped: "✗", blocked: "⚠︎" } as const;

/** The one glyph rule: a blocked task outranks its stored status. */
export function taskGlyph(task: Task, blocked: boolean): string {
  if (blocked) return TASK_GLYPHS.blocked;
  if (task.status === "complete") return TASK_GLYPHS.complete;
  if (task.status === "skipped") return TASK_GLYPHS.skipped;
  if (task.status === "in_progress") return TASK_GLYPHS.inProgress;
  return TASK_GLYPHS.pending;
}

// ---------------------------------------------------------------------------
// Construction

export function createState(): TodoState {
  return { version: TODO_SCHEMA_VERSION, nextId: 1, tasks: [] };
}

/**
 * True when the list holds no live work: it has tasks and every one is closed
 * (complete or skipped). Such a list is history — `add` starts a new one.
 */
export function isListFinished(state: TodoState): boolean {
  return state.tasks.length > 0 && state.tasks.every((t) => t.status === "complete" || t.status === "skipped");
}

/**
 * Start a new list: drop every task and restart the id sequence at #1, so the
 * panel reads like a fresh plan instead of continuing a number that only ever
 * counted tasks the user no longer sees.
 *
 * The cost is that ids are only unique WITHIN a list: an id the model read
 * before the rotation can name a different task afterwards. That is why the
 * rotation is always reported loudly by `add` ("ids restart at #1 — ignore
 * earlier #id references") and why rotating is the only place where ids are
 * reused — never while a list still has live work. The previous list is
 * history, not an archive: the store only ever holds the list that is being
 * worked on, and a finished list is garbage (gcDays).
 */
export function startNewList(_state: TodoState): TodoState {
  return { version: TODO_SCHEMA_VERSION, nextId: 1, tasks: [] };
}

const byId = (state: TodoState, id: number): Task | undefined =>
  state.tasks.find((t) => t.id === id);

export interface AddItem {
  title: string;
  parentId?: number | null;
}

export type ModelResult<T> = { ok: true; state: TodoState; value: T } | { ok: false; error: string };

const clone = (state: TodoState): TodoState => ({
  ...state,
  tasks: state.tasks.map((t) => ({ ...t, blockedBy: [...t.blockedBy], claim: t.claim ? { ...t.claim } : null })),
});

function depthOf(state: TodoState, id: number): number {
  let depth = 1;
  let cur = byId(state, id);
  while (cur?.parentId != null) {
    depth += 1;
    cur = byId(state, cur.parentId);
  }
  return depth;
}

/** True when `ancestorId` is `id` itself or one of its transitive parents. */
export function isAncestorOf(state: TodoState, ancestorId: number, id: number): boolean {
  let cur = byId(state, id);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId == null ? undefined : byId(state, cur.parentId);
  }
  return false;
}

function wouldCreateCycle(state: TodoState, id: number, newParentId: number): boolean {
  // parent chains never cycle by construction; only a reparent can. Moving id
  // under newParentId closes a loop iff newParentId is id or a descendant of id.
  let cur: Task | undefined = byId(state, newParentId);
  while (cur) {
    if (cur.id === id) return true;
    cur = cur.parentId == null ? undefined : byId(state, cur.parentId);
  }
  return false;
}

/** Titles that would duplicate an existing open task (case-insensitive). */
function openDuplicateTitles(state: TodoState): Set<string> {
  const seen = new Set<string>();
  for (const t of state.tasks) {
    if (t.status !== "complete" && t.status !== "skipped") seen.add(t.title.toLowerCase());
  }
  return seen;
}

export function addTasks(state: TodoState, items: AddItem[], now: number): ModelResult<Task[]> {
  if (items.length === 0) return { ok: false, error: "add: no items provided" };
  if (state.tasks.length + items.length > MAX_TASKS) {
    return { ok: false, error: `add: ${items.length} new tasks would exceed MAX_TASKS=${MAX_TASKS} (have ${state.tasks.length})` };
  }
  const next = clone(state);
  const added: Task[] = [];
  const dupes = openDuplicateTitles(state);
  const seenInBatch = new Set<string>();
  for (const item of items) {
    const title = sanitizeText(item.title);
    if (!title) return { ok: false, error: "add: empty title after sanitizing" };
    const key = title.toLowerCase();
    if (seenInBatch.has(key) || dupes.has(key)) {
      return { ok: false, error: `add: duplicate title "${title}" (distinct titles required across open tasks)` };
    }
    seenInBatch.add(key);
    let parentId: number | null = null;
    if (item.parentId != null) {
      const parent = byId(next, item.parentId);
      if (!parent) return { ok: false, error: `add: parent ${formatTaskId(item.parentId)} does not exist` };
      if (parent.status === "complete") return { ok: false, error: `add: parent ${formatTaskId(item.parentId)} is complete` };
      if (depthOf(next, parent.id) >= MAX_DEPTH) {
        return { ok: false, error: `add: parent ${formatTaskId(parent.id)} is at MAX_DEPTH=${MAX_DEPTH}` };
      }
      parentId = parent.id;
    }
    const task: Task = {
      id: next.nextId,
      title,
      parentId,
      status: "pending",
      blockedBy: [],
      claim: null,
      evidence: null,
      skipReason: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      completedAtTurn: null,
    };
    next.nextId += 1;
    next.tasks.push(task);
    added.push(task);
  }
  return { ok: true, state: next, value: added };
}

// ---------------------------------------------------------------------------
// Mutation primitives (each returns a NEW state; store persists)

function patchTask(state: TodoState, id: number, now: number, fn: (t: Task) => void): ModelResult<Task> {
  const next = clone(state);
  const task = byId(next, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  fn(task);
  task.updatedAt = now;
  return { ok: true, state: next, value: task };
}

export function updateTitle(state: TodoState, id: number, title: string, now: number): ModelResult<Task> {
  const clean = sanitizeText(title);
  if (!clean) return { ok: false, error: "update: empty title after sanitizing" };
  const dupe = state.tasks.find((t) => t.id !== id && t.status !== "complete" && t.status !== "skipped" && t.title.toLowerCase() === clean.toLowerCase());
  if (dupe) return { ok: false, error: `update: duplicate title "${clean}" (already used by ${formatTaskId(dupe.id)})` };
  return patchTask(state, id, now, (t) => { t.title = clean; });
}

export function moveTask(state: TodoState, id: number, parentId: number | null, now: number): ModelResult<Task> {
  if (parentId != null) {
    if (parentId === id) return { ok: false, error: `move: ${formatTaskId(id)} cannot be its own parent` };
    if (!byId(state, parentId)) return { ok: false, error: `move: parent ${formatTaskId(parentId)} does not exist` };
    if (wouldCreateCycle(state, id, parentId)) return { ok: false, error: `move: ${formatTaskId(parentId)} is a descendant of ${formatTaskId(id)} (cycle)` };
    if (depthOf(state, parentId) >= MAX_DEPTH) return { ok: false, error: `move: MAX_DEPTH=${MAX_DEPTH} reached` };
  }
  return patchTask(state, id, now, (t) => { t.parentId = parentId; });
}

export function transitionTask(state: TodoState, id: number, to: TaskStatus, now: number): ModelResult<Task> {
  const task = byId(state, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  if (task.status === to) return { ok: false, error: `no change: ${formatTaskId(id)} already ${to}` };
  if (!canTransition(task.status, to)) return { ok: false, error: transitionError(id, task.status, to) };
  const result = patchTask(state, id, now, (t) => {
    t.status = to;
    if (to === "complete") {
      t.completedAt = now;
      t.claim = null;
    }
    if (to === "pending") {
      t.completedAt = null;
      t.completedAtTurn = null;
      t.skipReason = null;
    }
  });
  return result;
}

export function skipTask(state: TodoState, id: number, reason: string, now: number): ModelResult<Task[]> {
  const task = byId(state, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  if (task.status === "skipped") return { ok: false, error: `no change: ${formatTaskId(id)} already skipped` };
  if (!canTransition(task.status, "skipped")) return { ok: false, error: transitionError(id, task.status, "skipped") };
  const clean = sanitizeText(reason);
  if (!clean) return { ok: false, error: "skip: reason required (record why for the ledger)" };
  // Cascade: unfinished descendants inherit the skip (pi-goal-x skipAllSubtasks).
  let next = clone(state);
  const affected: Task[] = [];
  const visit = (tid: number): void => {
    const t = next.tasks.find((x) => x.id === tid);
    if (!t) return;
    if (t.status === "pending" || t.status === "in_progress") {
      t.status = "skipped";
      t.skipReason = t.id === id ? clean : `parent ${formatTaskId(id)} skipped`;
      if (t.id === id) t.claim = null;
      t.updatedAt = now;
      affected.push(t);
    }
    for (const child of next.tasks.filter((x) => x.parentId === tid)) visit(child.id);
  };
  visit(id);
  next = { ...next };
  return { ok: true, state: next, value: affected };
}

// ---------------------------------------------------------------------------
// Completion gate + evidence (pi-goal-x policy, default block)

export function completionBlock(state: TodoState, id: number, evidence: string): string | null {
  const task = byId(state, id);
  if (!task) return `task ${formatTaskId(id)} not found`;
  const openChildren = state.tasks
    .filter((t) => isAncestorOf(state, id, t.id) && t.id !== id && t.status !== "complete" && t.status !== "skipped")
    .map((t) => `${formatTaskId(t.id)} ${t.title}`);
  if (openChildren.length > 0) {
    return `completion blocked: unfinished subtasks remain — ${openChildren.join("; ")}`;
  }
  if (!sanitizeText(evidence)) return `completion blocked: evidence required (what proves ${formatTaskId(id)} is done?)`;
  return null;
}

export function completeTask(state: TodoState, id: number, evidence: string, now: number, turn: number): ModelResult<Task> {
  const block = completionBlock(state, id, evidence);
  if (block) return { ok: false, error: block };
  return patchTask(state, id, now, (t) => {
    t.status = "complete";
    t.completedAt = now;
    t.completedAtTurn = turn;
    t.evidence = sanitizeText(evidence);
    t.claim = null;
  });
}

// ---------------------------------------------------------------------------
// Claims (subagent ownership)

export function claimTask(state: TodoState, id: number, session: string, now: number, force = false): ModelResult<Task> {
  const task = byId(state, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  if (task.status === "complete" || task.status === "skipped") {
    return { ok: false, error: `claim: ${formatTaskId(id)} is ${task.status}` };
  }
  if (task.claim && task.claim.session !== session && !force) {
    return { ok: false, error: `claim: ${formatTaskId(id)} is claimed by ${task.claim.session} (retry with force to take it over)` };
  }
  const result = patchTask(state, id, now, (t) => {
    t.claim = { session, at: now };
    if (t.status === "pending") t.status = "in_progress";
  });
  return result;
}

export function releaseTask(state: TodoState, id: number, session: string, now: number, force = false): ModelResult<Task> {
  const task = byId(state, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  if (!task.claim) return { ok: false, error: `no change: ${formatTaskId(id)} is unclaimed` };
  if (task.claim.session !== session && !force) {
    return { ok: false, error: `release: ${formatTaskId(id)} is claimed by ${task.claim.session} (force to override)` };
  }
  const result = patchTask(state, id, now, (t) => {
    t.claim = null;
    if (t.status === "in_progress") t.status = "pending";
  });
  return result;
}

// ---------------------------------------------------------------------------
// blockedBy dependency edges

/** Transitive blockedBy reachability: can `from` reach `to` through waits-for edges? */
function reachesViaBlockedBy(state: TodoState, from: number, to: number): boolean {
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const task = byId(state, cur);
    if (task) stack.push(...task.blockedBy);
  }
  return false;
}

function dependencyErrorAdding(state: TodoState, id: number, dep: number): string | null {
  if (id === dep) return `blockedBy: ${formatTaskId(id)} cannot depend on itself`;
  if (!byId(state, id)) return `task ${formatTaskId(id)} not found`;
  if (!byId(state, dep)) return `blockedBy: ${formatTaskId(dep)} does not exist`;
  if (state.tasks.find((t) => t.id === id)?.blockedBy.includes(dep)) {
    return `no change: ${formatTaskId(id)} is already blocked by ${formatTaskId(dep)}`;
  }
  // Cycle in waits-for edges: dep must not (transitively) wait on id.
  // A child waiting on its PARENT is legal ("waiting on parent" is useful
  // signal, not deadlock) — only blockedBy edges form the cycle check.
  if (reachesViaBlockedBy(state, dep, id)) return `blockedBy: ${formatTaskId(dep)} already waits on ${formatTaskId(id)} (cycle)`;
  return null;
}

export function addBlockedBy(state: TodoState, id: number, dep: number, now: number): ModelResult<Task> {
  const err = dependencyErrorAdding(state, id, dep);
  if (err) return { ok: false, error: err };
  return patchTask(state, id, now, (t) => { t.blockedBy.push(dep); t.blockedBy.sort((a, b) => a - b); });
}

export function removeBlockedBy(state: TodoState, id: number, dep: number, now: number): ModelResult<Task> {
  const task = byId(state, id);
  if (!task) return { ok: false, error: `task ${formatTaskId(id)} not found` };
  if (!task.blockedBy.includes(dep)) return { ok: false, error: `no change: ${formatTaskId(id)} is not blocked by ${formatTaskId(dep)}` };
  return patchTask(state, id, now, (t) => { t.blockedBy = t.blockedBy.filter((x) => x !== dep); });
}

/** True while any blocker is itself unfinished (drives the ⚠ marker). */
export function isBlocked(state: TodoState, id: number): boolean {
  const task = byId(state, id);
  if (!task) return false;
  return task.blockedBy.some((dep) => {
    const d = byId(state, dep);
    return d ? d.status !== "complete" : false;
  });
}

// ---------------------------------------------------------------------------
// Derived tree state (never stored — render-time only, pi-goal-x derive)

export interface DerivedNode {
  task: Task;
  depth: number;
  children: DerivedNode[];
  /** Status shown for a parent: derived from its children. */
  displayStatus: TaskStatus | "blocked";
}

export function buildTree(state: TodoState): DerivedNode[] {
  const nodes = new Map<number, DerivedNode>();
  for (const task of state.tasks) {
    nodes.set(task.id, { task, depth: 1, children: [], displayStatus: task.status });
  }
  const roots: DerivedNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.task.parentId == null ? undefined : nodes.get(node.task.parentId);
    if (parent) {
      parent.children.push(node);
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
  }
  const derive = (node: DerivedNode): void => {
    for (const child of node.children) derive(child);
    if (node.children.length > 0) {
      const list = node.children;
      const allComplete = list.every((c) => c.task.status === "complete" || c.task.status === "skipped");
      const allSkipped = list.every((c) => c.task.status === "skipped");
      const anyLive = list.some((c) => c.task.status === "in_progress");
      node.displayStatus = allSkipped ? "skipped" : allComplete ? "complete" : anyLive ? "in_progress" : "pending";
    } else if (isBlocked(state, node.task.id)) {
      node.displayStatus = "blocked";
    } else if (node.displayStatus === "in_progress") {
      node.displayStatus = "in_progress";
    }
  };
  for (const root of roots) derive(root);
  return roots;
}

/** Depth-first flattened view for the widget rendering. */
export function flattenTree(roots: DerivedNode[]): DerivedNode[] {
  const out: DerivedNode[] = [];
  const visit = (node: DerivedNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

/** First unclaimed, unblocked, pending leaf — the "next" suggestion. */
export function nextTaskId(state: TodoState): number | null {
  const flat = flattenTree(buildTree(state));
  const node = flat.find((n) => n.task.parentId !== null || n.children.length === 0
    ? n.task.status === "pending" && !n.task.claim && !isBlocked(state, n.task.id)
    : false);
  return node ? node.task.id : null;
}
