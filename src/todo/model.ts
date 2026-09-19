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
/** Task ids render as `#<id>` everywhere (widget, overlay, tool text). */
export const formatTaskId = (id: number): string => `#${id}`;

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

// ---------------------------------------------------------------------------
// Construction

export function createState(): TodoState {
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
  if (!result.ok) return result;
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
  if (!result.ok) return result;
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
  if (!result.ok) return result;
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

/** Depth-first flattened view for widget/overlay rendering. */
export function flattenTree(roots: DerivedNode[]): DerivedNode[] {
  const out: DerivedNode[] = [];
  const visit = (node: DerivedNode): void => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

export interface Progress {
  total: number;
  complete: number;
  skipped: number;
  inProgress: number;
  pending: number;
}

/** Progress over leaf tasks only — parents are summaries, not work units. */
export function progressOf(state: TodoState): Progress {
  const parents = new Set(state.tasks.filter((t) => t.parentId != null).map((t) => t.parentId));
  const leaves = state.tasks.filter((t) => !parents.has(t.id));
  const p: Progress = { total: leaves.length, complete: 0, skipped: 0, inProgress: 0, pending: 0 };
  for (const leaf of leaves) {
    if (leaf.status === "complete") p.complete += 1;
    else if (leaf.status === "skipped") p.skipped += 1;
    else if (leaf.status === "in_progress") p.inProgress += 1;
    else p.pending += 1;
  }
  return p;
}

/** First unclaimed, unblocked, pending leaf — the "next" suggestion. */
export function nextTaskId(state: TodoState): number | null {
  const flat = flattenTree(buildTree(state));
  const node = flat.find((n) => n.task.parentId !== null || n.children.length === 0
    ? n.task.status === "pending" && !n.task.claim && !isBlocked(state, n.task.id)
    : false);
  return node ? node.task.id : null;
}

// ---------------------------------------------------------------------------
// No-change detection (rpiv-todo): field-level diff for tool results.

const TASK_FIELDS = ["title", "parentId", "status", "evidence", "skipReason", "completedAt", "completedAtTurn"] as const;

export function diffTask(before: Task, after: Task): string[] {
  const changes: string[] = [];
  for (const field of TASK_FIELDS) {
    if (before[field] !== after[field]) changes.push(field);
  }
  if (before.claim?.session !== after.claim?.session) changes.push("claim");
  if (before.blockedBy.join(",") !== after.blockedBy.join(",")) changes.push("blockedBy");
  return changes;
}
