// codex-todo — disk store. Owns the ONE on-disk fact (tasks.json), the
// cross-process write lock, and GC. Model functions (model.ts) stay pure; this
// file only persists their outputs.
//
// Lessons baked in (docs/0.16.0-todo-plugin-plan.md):
// - Single source of truth: one JSON file with a version field (tool name and
//   schema are an immutable ABI — rpiv-todo). No ledgers, no mirrors.
// - Atomic write via tmp file + rename; a corrupt file is renamed to a
//   timestamped backup and we start empty, never crash the session.
// - Cross-process mutation lock (separate pi sessions in two terminals can
//   share a repo): atomic `wx` create, 30-minute TTL, expired locks are
//   archived (not silently deleted) for /codex-todo-doctor to report. The lock
//   guards the read-modify-write instant only — task claims live in the task
//   records themselves (pi-agent-extensions: claim ≠ lock).
// - Tests must use a tmpdir; nothing here ever touches a real HOME.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createState,
  TODO_SCHEMA_VERSION,
  type ModelResult,
  type TodoState,
  type Task,
} from "./model.ts";

export const TODO_DIR_NAME = ".pi/codex-todos";
export const TODO_STATE_FILE = "tasks.json";
export const TODO_SETTINGS_FILE = "settings.json";
export const TODO_LOCK_FILE = "tasks.lock";
export const LOCK_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_GC_DAYS = 7;

export interface TodoSettings {
  gcDays: number;
}

interface LockInfo {
  pid: number;
  session: string;
  at: number;
}

export interface StoreStatus {
  dir: string;
  stateFile: boolean;
  taskCount: number;
  settings: TodoSettings;
  lock: { held: boolean; stale: boolean; info: LockInfo | null };
  backups: string[];
  /** Set when a corrupt state file was archived during this process's reads. */
  recoveredFrom: string | null;
}

export interface TodoStore {
  readonly dir: string;
  read(): TodoState;
  settings(): TodoSettings;
  /** Apply a pure model function atomically; the state file is re-read under
   *  the lock so concurrent writers never clobber each other. */
  mutate<T>(fn: (state: TodoState) => ModelResult<T>): Promise<{ ok: true; value: T; state: TodoState } | { ok: false; error: string }>;
  /** GC eligible closed tasks; returns how many were removed. */
  collect(now?: number): number;
  status(): StoreStatus;
  dispose(): void;
}

const readJson = (path: string): unknown | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const isTask = (t: unknown): t is Task => {
  if (typeof t !== "object" || t === null) return false;
  const x = t as Record<string, unknown>;
  return typeof x.id === "number" && typeof x.title === "string"
    && (x.parentId === null || typeof x.parentId === "number")
    && typeof x.status === "string"
    && Array.isArray(x.blockedBy)
    && typeof x.createdAt === "number" && typeof x.updatedAt === "number";
};

const normalizeState = (raw: unknown): TodoState | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const x = raw as Record<string, unknown>;
  if (x.version !== TODO_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(x.tasks) || !x.tasks.every(isTask)) return undefined;
  const ids = new Set<number>();
  for (const t of x.tasks as Task[]) {
    if (ids.has(t.id)) return undefined;
    ids.add(t.id);
  }
  const nextId = typeof x.nextId === "number" && x.nextId > 0
    ? x.nextId
    : Math.max(0, ...(x.tasks as Task[]).map((t) => t.id)) + 1;
  return { version: TODO_SCHEMA_VERSION, nextId, tasks: x.tasks as Task[] };
};

export function openTodoStore(dir: string, deps: { now?: () => number; session?: string; fs?: Pick<typeof import("node:fs"), "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "existsSync" | "readdirSync" | "unlinkSync"> } = {}): TodoStore {
  const fs = deps.fs ?? { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync };
  const now = deps.now ?? Date.now;
  const session = deps.session ?? `pid-${process.pid}`;
  const statePath = join(dir, TODO_STATE_FILE);
  const settingsPath = join(dir, TODO_SETTINGS_FILE);
  const lockPath = join(dir, TODO_LOCK_FILE);

  fs.mkdirSync(dir, { recursive: true });

  let queue: Promise<unknown> = Promise.resolve();
  let recoveredBackup: string | null = null;

  const loadSettings = (): TodoSettings => {
    const raw = readJson(settingsPath) as Record<string, unknown> | undefined;
    const gcDays = typeof raw?.gcDays === "number" && raw.gcDays >= 0 ? raw.gcDays : DEFAULT_GC_DAYS;
    return { gcDays };
  };

  const readState = (): TodoState => {
    const raw = readJson(statePath);
    if (raw === undefined) {
      if (fs.existsSync(statePath)) {
        // Corrupt state: archive for /codex-todo-doctor, start empty. A bad
        // todo file must never take the session down with it.
        const backup = `${TODO_STATE_FILE}.bak-${now()}`;
        try {
          fs.renameSync(statePath, join(dir, backup));
          recoveredBackup = backup;
        } catch {
          // If archiving itself fails, still start empty.
        }
      }
      return createState();
    }
    const state = normalizeState(raw);
    if (!state) {
      const backup = `${TODO_STATE_FILE}.bak-${now()}`;
      try {
        fs.renameSync(statePath, join(dir, backup));
        recoveredBackup = backup;
      } catch { /* start empty regardless */ }
      return createState();
    }
    return state;
  };

  const writeState = (state: TodoState): void => {
    const tmp = `${statePath}.tmp-${process.pid}-${now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, statePath);
  };

  const acquireLock = (): void => {
    const info: LockInfo = { pid: process.pid, session, at: now() };
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeFileSync(lockPath, JSON.stringify(info), { flag: "wx", mode: 0o600 });
        return;
      } catch {
        // Busy or stale — check TTL, archive expired locks, retry briefly.
        const existing = readJson(lockPath) as LockInfo | undefined;
        const stale = existing !== undefined && now() - existing.at > LOCK_TTL_MS;
        if (stale) {
          try {
            fs.renameSync(lockPath, join(dir, `stale-lock-${existing.session}-${existing.at}.json`));
            continue;
          } catch { /* fall through to retry */ }
        }
        if (attempt >= 4) throw new Error(`todo store is busy (lock held by ${existing?.session ?? "unknown"}; a stale lock older than 30min is archived automatically)`);
        // Tiny synchronous backoff via Atomics on a shared buffer is overkill —
        // mutations are rare; a short busy retry is enough for same-process
        // interleavings, and cross-process contention is user-visible anyway.
        const waitUntil = Date.now() + 40 * (attempt + 1);
        while (Date.now() < waitUntil) { /* spin: mutations are milliseconds */ }
      }
    }
  };

  const releaseLock = (): void => {
    try {
      fs.unlinkSync(lockPath);
    } catch { /* releasing must never throw */ }
  };

  const gcOnce = (state: TodoState): TodoState => {
    const { gcDays } = loadSettings();
    if (gcDays <= 0) return state;
    const cutoff = now() - gcDays * 24 * 60 * 60 * 1000;
    const removable = new Set<number>();
    for (const t of state.tasks) {
      if (t.status !== "complete" || t.completedAt == null || t.completedAt > cutoff) continue;
      const hasOpenDescendants = state.tasks.some((d) => {
        let cur: Task | undefined = d;
        while (cur && cur.parentId != null) {
          if (cur.parentId === t.id) return d.status !== "complete" && d.status !== "skipped";
          cur = state.tasks.find((x) => x.id === cur!.parentId);
        }
        return false;
      });
      if (!hasOpenDescendants) removable.add(t.id);
    }
    if (removable.size === 0) return state;
    // Children of a removed task reparent to its parent, preserving the tree.
    const tasks = state.tasks
      .filter((t) => !removable.has(t.id))
      .map((t) => removable.has(t.parentId ?? -1) ? { ...t, parentId: state.tasks.find((p) => p.id === t.parentId)?.parentId ?? null } : t);
    return { ...state, tasks };
  };

  const store: TodoStore = {
    dir,
    read: readState,
    settings: loadSettings,
    mutate: <T>(fn: (state: TodoState) => ModelResult<T>) => {
      const run = queue.then((): { ok: true; value: T; state: TodoState } | { ok: false; error: string } => {
        acquireLock();
        try {
          const fresh = readState();
          const result = fn(fresh);
          if (!result.ok) return { ok: false, error: result.error };
          const cleaned = gcOnce(result.state);
          writeState(cleaned);
          return { ok: true, value: result.value, state: cleaned };
        } finally {
          releaseLock();
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
    collect: () => {
      const before = readState();
      const after = gcOnce(before);
      if (after !== before) writeState(after);
      return before.tasks.length - after.tasks.length;
    },
    status: () => {
      const state = readState();
      const lockInfo = readJson(lockPath) as LockInfo | undefined;
      const held = fs.existsSync(lockPath);
      return {
        dir,
        stateFile: fs.existsSync(statePath),
        taskCount: state.tasks.length,
        settings: loadSettings(),
        lock: { held, stale: lockInfo !== undefined && now() - lockInfo.at > LOCK_TTL_MS, info: lockInfo ?? null },
        backups: fs.readdirSync(dir).filter((f) => f.includes(".bak-") || f.startsWith("stale-lock-")),
        recoveredFrom: recoveredBackup,
      };
    },
    dispose: () => {
      queue = Promise.resolve();
    },
  };
  return store;
}
