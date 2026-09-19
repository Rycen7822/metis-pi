// Session change counts for the footer (+A −D). Display-only: it reads git and
// the work tree, never writes to the index or the tree, never throws, and
// reports nothing (rather than a wrong 0) when the data cannot be read.
//
// 0.13.0 semantics — the footer answers "what did THIS session change?":
//
//   * the session's FIRST read is the baseline, per path, so work-tree changes
//     that predate the session are not credited to it;
//   * every later read diffs against the revision the session STARTED from, so
//     commits made during the session do not erase progress — the numbers are
//     the session's cumulative ABSOLUTE additions and deletions, never a net
//     line-count delta ("file grew by 3" is not "file changed by +3 −0");
//   * untracked, non-ignored files contribute the lines they gained since the
//     baseline;
//   * every writer counts the same way — the agent's tools, a bash/sed/python
//     script, another terminal — because the numbers come from git and the work
//     tree, never from a tool ledger.
//
// Bounded by design: one git process per read with a hard timeout, ≤200
// untracked files, ≤256 KiB streamed from each (counted in chunks, cached by
// size+mtime so an unchanged tree is not re-read), and a cwd without git
// metadata clears the stat without spawning git at all.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitChangeStat {
  readonly additions: number;
  readonly deletions: number;
  /** Changed paths credited to the session (tracked + untracked). */
  readonly files: number;
}

export interface ChangeCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** One read of the work tree relative to a fixed revision. */
export interface ChangeSample {
  /** `git diff --numstat <rev>` rows, keyed by path (renames → the new path). */
  readonly tracked: ReadonlyMap<string, ChangeCounts>;
  /** Untracked, non-ignored files: path → counted lines. */
  readonly untracked: ReadonlyMap<string, number>;
}

export interface GitExecResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export type GitExec = (args: readonly string[], cwd: string) => Promise<GitExecResult>;
export type ReadLineCount = (path: string) => Promise<LineCount | undefined>;

export const GIT_CHANGES_INTERVAL_MS = 2_000;
/** Activity-driven refresh debounce (agent/tool events, not the interval). */
export const GIT_CHANGES_DEBOUNCE_MS = 250;
export const GIT_EXEC_TIMEOUT_MS = 5_000;
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_BYTES = 262_144;
const BINARY_PROBE_BYTES = 8_192;
const READ_CHUNK_BYTES = 65_536;
const MAX_CACHE_ENTRIES = 2_000;

/**
 * `<add>\t<del>\t<path>\0` rows from `git diff --numstat -z`. Binary rows use
 * "-" for both counts: the path is still a changed file, with no line counts. A
 * rename row is followed by two more NUL fields (old path, new path) and is
 * keyed by the new path. Paths may contain tabs and newlines — only NUL splits.
 */
export function parseNumstatZ(stdout: string): Map<string, ChangeCounts> {
  const counts = new Map<string, ChangeCounts>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const row = fields[i]!;
    if (!row) continue;
    const parts = row.split("\t");
    if (parts.length < 3) continue;
    const additions = Number.parseInt(parts[0]!, 10) || 0;
    const deletions = Number.parseInt(parts[1]!, 10) || 0;
    let path = parts.slice(2).join("\t");
    if (path === "") {
      // Rename: counts, an empty field, then old and new paths.
      const target = fields[i + 2];
      if (target === undefined) break;
      path = target;
      i += 2;
    }
    if (!path) continue;
    counts.set(path, { additions, deletions });
  }
  return counts;
}

/** NUL-separated paths from `git ls-files --others --exclude-standard -z`. */
export function parseUntracked(stdout: string): string[] {
  return stdout.split("\0").filter((path) => path.length > 0);
}

/** Lines in a text blob: "a\nb\n" and "a\nb" both count 2, "" counts 0. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

export interface LineCount {
  /** Counted lines; the trailing line counts even without a final newline. */
  readonly lines: number;
  /** Bytes actually read (the cache key's size half). */
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Streams one work-tree file: counts lines without loading it, skips binaries
 * (NUL in the first chunk) and anything over the byte cap. undefined = not
 * countable, which the caller must NOT treat as zero lines.
 */
export async function readLineCount(path: string): Promise<LineCount | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) return undefined;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, info.size)));
    let lines = 0;
    let total = 0;
    let lastByte = -1;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (total === 0 && buffer.subarray(0, Math.min(bytesRead, BINARY_PROBE_BYTES)).includes(0)) return undefined;
      total += bytesRead;
      if (total > MAX_UNTRACKED_BYTES) return undefined;
      for (let at = buffer.indexOf(10, 0); at !== -1 && at < bytesRead; at = buffer.indexOf(10, at + 1)) lines += 1;
      lastByte = buffer[bytesRead - 1]!;
    }
    if (total === 0) return { lines: 0, size: 0, mtimeMs: info.mtimeMs };
    return { lines: lastByte === 10 ? lines : lines + 1, size: total, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => { /* read-only handle */ });
  }
}

export interface LineCountCache {
  /** Cached count, re-read only when size or mtime moved. */
  count(path: string): Promise<LineCount | undefined>;
  clear(): void;
}

export function createLineCountCache(deps: { read?: ReadLineCount } = {}): LineCountCache {
  const read = deps.read ?? readLineCount;
  const cache = new Map<string, LineCount>();
  return {
    async count(path: string): Promise<LineCount | undefined> {
      let info;
      try {
        info = await stat(path);
      } catch {
        cache.delete(path);
        return undefined;
      }
      if (!info.isFile()) {
        cache.delete(path);
        return undefined;
      }
      const cached = cache.get(path);
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;
      const next = await read(path);
      if (next) {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
        cache.set(path, next);
      } else {
        cache.delete(path);
      }
      return next;
    },
    clear: () => cache.clear(),
  };
}

/** Walk up for git metadata (a .git directory, or a file in worktrees). Cheap
 * pre-check that keeps non-repo sessions from spawning git every interval. */
export function findGitDir(cwd: string): string | undefined {
  if (!cwd) return undefined;
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function defaultExec(args: readonly string[], cwd: string): Promise<GitExecResult> {
  return await new Promise<GitExecResult>((resolvePromise) => {
    execFile(
      "git",
      // --no-optional-locks: never take the index lock from a background reader.
      // --no-ext-diff/--no-textconv: never spawn a user's diff driver or a
      // smudge filter (a GUI diff tool or a stalled filter would hang the poll).
      ["--no-optional-locks", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        timeout: GIT_EXEC_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (error, stdout) => resolvePromise({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" }),
    );
  });
}

export type ChangeReadResult =
  | { readonly kind: "sample"; readonly sample: ChangeSample }
  /** No git metadata in cwd: nothing to show. */
  | { readonly kind: "no-repo" }
  /** Git answered with an error or timed out: keep the previous numbers. */
  | { readonly kind: "error" };

/** The revision the session diffs against: HEAD at session start. undefined =
 * unborn HEAD (no commits yet), where the read compares index ↔ work tree. */
export async function resolveSessionRev(cwd: string, deps: { exec?: GitExec } = {}): Promise<string | undefined> {
  const exec = deps.exec ?? defaultExec;
  const result = await exec(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  const rev = result.stdout.trim();
  return result.ok && rev ? rev : undefined;
}

export interface ChangeReadDeps {
  exec?: GitExec;
  lineCounts?: LineCountCache;
  /** Session revision from resolveSessionRev(); undefined = index ↔ work tree. */
  rev?: string | undefined;
}

const sharedLineCounts = createLineCountCache();

/** One full read of the work tree relative to `rev` (or to the index). */
export async function readChangeSample(cwd: string, deps: ChangeReadDeps = {}): Promise<ChangeReadResult> {
  if (!findGitDir(cwd)) return { kind: "no-repo" };
  const exec = deps.exec ?? defaultExec;
  const counts = deps.lineCounts ?? sharedLineCounts;

  const diffArgs = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"];
  if (deps.rev) diffArgs.push(deps.rev);
  const tracked = await exec(diffArgs, cwd);
  if (!tracked.ok) return { kind: "error" };
  const untracked = await exec(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (!untracked.ok) return { kind: "error" };

  const untrackedLines = new Map<string, number>();
  for (const path of parseUntracked(untracked.stdout).slice(0, MAX_UNTRACKED_FILES)) {
    const count = await counts.count(join(cwd, path));
    if (count) untrackedLines.set(path, count.lines);
  }
  return { kind: "sample", sample: { tracked: parseNumstatZ(tracked.stdout), untracked: untrackedLines } };
}

/**
 * The session's cumulative change stat: every path's absolute counts beyond
 * what the baseline already had. Clamped per path and dimension, so a session
 * that reverts someone else's pending edit reports nothing rather than a
 * negative.
 */
export function sessionChangeStat(sample: ChangeSample, baseline: ChangeSample | undefined): GitChangeStat {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const [path, counts] of sample.tracked) {
    const base = baseline?.tracked.get(path);
    // A file that was UNTRACKED at the baseline and got committed during the
    // session: its baseline lines are still not the session's work.
    const baseAdd = base?.additions ?? baseline?.untracked.get(path) ?? 0;
    const baseDel = base?.deletions ?? 0;
    const add = Math.max(0, counts.additions - baseAdd);
    const del = Math.max(0, counts.deletions - baseDel);
    additions += add;
    deletions += del;
    if (add > 0 || del > 0) files += 1;
  }
  for (const [path, lines] of sample.untracked) {
    const baselineLines = baseline?.untracked.get(path);
    // Tracked at the baseline and untracked now (git rm --cached): its content
    // predates the session, so credit nothing rather than guessing.
    const existing = baselineLines ?? (baseline?.tracked.has(path) ? lines : 0);
    const add = Math.max(0, lines - existing);
    if (add > 0) {
      additions += add;
      files += 1;
    }
  }
  return { additions, deletions, files };
}

export interface GitChangesSession {
  /** Revision the session diffs against (undefined = unborn HEAD / no repo). */
  readonly rev: string | undefined;
  /** True once the first read captured the session baseline. */
  readonly baseline: boolean;
}

export interface GitChangesTracker {
  /** Latest session stat; undefined = not a repo / nothing read yet. */
  snapshot(): GitChangeStat | undefined;
  /** Refresh now; concurrent calls coalesce onto the in-flight read. */
  refresh(): Promise<void>;
  /** Activity signal (agent/tool work): debounced refresh while armed. */
  touch(): void;
  /** Arm the interval (idempotent; TUI sessions only). */
  start(): void;
  /** Disarm, forget the stat and the baseline. */
  dispose(): void;
  /** Diagnostics: what the session is diffing against. */
  session(): GitChangesSession;
  /** True while the interval is armed. */
  readonly running: boolean;
}

function sameStat(a: GitChangeStat | undefined, b: GitChangeStat | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.additions === b.additions && a.deletions === b.deletions && a.files === b.files;
}

export function createGitChangesTracker(deps: {
  getCwd: () => string;
  onUpdate?: () => void;
  exec?: GitExec;
  lineCounts?: LineCountCache;
  intervalMs?: number;
  debounceMs?: number;
  now?: () => number;
}): GitChangesTracker {
  const intervalMs = deps.intervalMs ?? GIT_CHANGES_INTERVAL_MS;
  const debounceMs = deps.debounceMs ?? GIT_CHANGES_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());
  const lineCounts = deps.lineCounts ?? createLineCountCache();

  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let current: GitChangeStat | undefined;
  let baseline: ChangeSample | undefined;
  let rev: string | undefined;
  let revCwd: string | undefined;
  let revReady = false;
  let lastReadAt = 0;
  let lastReadMs = 0;
  let generation = 0;

  const run = async (gen: number): Promise<void> => {
    const cwd = deps.getCwd();
    if (cwd !== revCwd) {
      // A new work tree (session /cd): new baseline, new revision.
      revCwd = cwd;
      baseline = undefined;
      current = undefined;
      rev = undefined;
      revReady = false;
      lineCounts.clear();
    }
    if (!revReady) {
      rev = await resolveSessionRev(cwd, deps);
      if (gen !== generation) return;
      revReady = true;
    }

    const started = now();
    const result = await readChangeSample(cwd, { exec: deps.exec, lineCounts, rev });
    if (gen !== generation) return; // disposed (or re-armed) mid-read
    lastReadMs = now() - started;
    lastReadAt = now();

    if (result.kind === "error") return; // keep the last good numbers
    if (result.kind === "no-repo") {
      const changed = current !== undefined;
      current = undefined;
      baseline = undefined;
      rev = undefined;
      revReady = false;
      if (changed) deps.onUpdate?.();
      return;
    }

    baseline ??= result.sample;
    const next = sessionChangeStat(result.sample, baseline);
    const changed = !sameStat(current, next);
    current = next;
    if (changed) deps.onUpdate?.();
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const gen = generation;
    inFlight = run(gen)
      .catch(() => { /* git reads never surface as agent-visible errors */ })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };

  return {
    snapshot: () => current,
    refresh,
    touch: () => {
      if (timer === undefined || pending !== undefined) return;
      // The debounce already spaces fast reads; a SLOW work tree (a git read
      // that takes seconds) additionally holds the next one off for twice its
      // own duration, so activity can never queue git work back to back.
      const wait = Math.max(debounceMs, lastReadMs * 2 - (now() - lastReadAt));
      const handle = setTimeout(() => {
        pending = undefined;
        void refresh();
      }, wait);
      (handle as unknown as { unref?: () => void }).unref?.();
      pending = handle;
    },
    start: () => {
      if (timer !== undefined) return;
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    dispose: () => {
      generation += 1;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
      current = undefined;
      baseline = undefined;
      rev = undefined;
      revReady = false;
      revCwd = undefined;
      lineCounts.clear();
    },
    session: () => ({ rev, baseline: baseline !== undefined }),
    get running() {
      return timer !== undefined;
    },
  };
}
