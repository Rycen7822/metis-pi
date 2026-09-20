// Session change counts for the footer (+A −D). Display-only: it reads git and
// the work tree, never writes to the user's index or tree, never throws, and
// reports nothing (rather than a wrong 0) when the data cannot be read.
//
// 0.19.3 semantics — the footer answers "how much code has THIS session
// changed?" and counts observed CHURN, not a snapshot of the current diff:
//
//   * every read compares each path's CONTENT with the content the session last
//     saw for that path and ADDS the difference to the session totals. An edit
//     that writes 14 lines and a later edit that deletes them again counts +14
//     AND −14 — they do not cancel out, and the 5 lines written in their place
//     count too.
//   * up to 0.19.2 the totals came from subtracting two HEAD-anchored
//     `git diff --numstat` samples per path. That loses deletions twice over:
//     work the session added and then removed is invisible to any state
//     comparison, and when an edit overlapped work that was already uncommitted
//     at session start the subtraction was not even arithmetically valid (a
//     real 3-line rewrite was reported as +0 −0).
//   * the reference for "what this session did" is content, not a revision: the
//     session's first read is the reference per path, so work that predates the
//     session is never credited, and an edit inside pre-existing uncommitted
//     work counts exactly like any other edit.
//   * a commit folds the committed delta out of the totals (0.15.4 holds: the
//     committed work stops counting, work that is still uncommitted keeps
//     counting); a work tree with no diffs and no untracked files resets them.
//   * untracked, non-ignored files count the same way, including the lines a
//     later write removes from them.
//   * the numbers are ABSOLUTE additions and deletions, never a net line-count
//     delta ("file grew by 3" is not "file changed by +3 −0").
//
// Content is compared through git's own machinery without touching the user's
// repository: a changed path is hashed with `git hash-object -w --no-filters`
// into a session-private GIT_OBJECT_DIRECTORY under the OS temp dir, and
// `git diff --numstat <oldBlob> <newBlob>` yields the exact churn. No index,
// worktree or object in .git/objects is ever written, no diff driver, textconv
// or clean/smudge filter ever runs, and every failure leaves the previous
// totals in place instead of guessing.
//
// Bounded by design: two git processes per read (work-tree diff + untracked
// list) plus one hash and one blob diff per path that CHANGED since the last
// read, ≤200 untracked files, ≤256 KiB streamed from each untracked file
// (counted in chunks, cached by size+mtime so an unchanged tree is not
// re-read), a 5s timeout on every git call, and a cwd without git metadata
// clears the stat without spawning git at all.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitChangeStat {
  /** Session churn so far: lines written. */
  readonly additions: number;
  /** Session churn so far: lines deleted. */
  readonly deletions: number;
  /** Paths that contributed churn since the totals were last reset. */
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

export type GitExec = (args: readonly string[], cwd: string, env?: Record<string, string>) => Promise<GitExecResult>;
export type ReadLineCount = (path: string) => Promise<LineCount | undefined>;

export const GIT_CHANGES_INTERVAL_MS = 2_000;
/** Activity-driven refresh debounce (agent/tool events, not the interval). */
export const GIT_CHANGES_DEBOUNCE_MS = 250;
export const GIT_EXEC_TIMEOUT_MS = 5_000;
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_BYTES = 262_144;
/** Content references kept per session (a later edit of an evicted path counts
 * as a fresh change, which is the one place churn can over-report). */
export const MAX_OBSERVED_PATHS = 2_000;
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

async function defaultExec(args: readonly string[], cwd: string, env?: Record<string, string>): Promise<GitExecResult> {
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
        env: env ? { ...process.env, ...env } : process.env,
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

/** The revision the work tree currently diffs against: HEAD right now.
 * undefined = unborn HEAD (no commits yet), where the read compares index ↔
 * work tree. HEAD is re-resolved every read so a commit is seen next poll. */
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

/** What the session last saw for one path: a content reference, not a revision. */
export interface PathSnapshot {
  /** Blob id of the content; "" when the content could not be referenced. */
  readonly blob: string;
  /** True when the path did not exist at that moment. */
  readonly missing: boolean;
  /** Work-tree stat then; 0/0 for a missing path. */
  readonly size: number;
  readonly mtimeMs: number;
  /** State counts then — the fallback for paths whose content is unavailable. */
  readonly counts: ChangeCounts;
}

/** Same absolute counts (the cheap half of the changed-path test). */
function sameCounts(a: ChangeCounts, b: ChangeCounts): boolean {
  return a.additions === b.additions && a.deletions === b.deletions;
}

/** True when the path's work-tree state is the one the snapshot describes. */
export function samePathState(snapshot: PathSnapshot, info: { size: number; mtimeMs: number } | undefined): boolean {
  if (!info) return snapshot.missing;
  if (snapshot.missing) return false;
  return snapshot.size === info.size && snapshot.mtimeMs === info.mtimeMs;
}

/** Subtract a committed delta from the session totals, clamped per dimension. */
export function foldCommitted(totals: ChangeCounts, committed: ChangeCounts): ChangeCounts {
  return {
    additions: Math.max(0, totals.additions - committed.additions),
    deletions: Math.max(0, totals.deletions - committed.deletions),
  };
}

/** Growth of a path's state counts: the fallback churn of an unreadable path. */
export function countsGrowth(previous: ChangeCounts, next: ChangeCounts): ChangeCounts {
  return {
    additions: Math.max(0, next.additions - previous.additions),
    deletions: Math.max(0, next.deletions - previous.deletions),
  };
}

/**
 * Per-path counts a commit swept past the reference revision (oldRev → newRev).
 * With an unborn oldRev the whole tree of newRev counts (diff-tree --root).
 * Undefined = the read failed; the caller then keeps its totals unchanged.
 */
async function committedDelta(exec: GitExec, cwd: string, oldRev: string, newRev: string | undefined): Promise<Map<string, ChangeCounts> | undefined> {
  const args = newRev
    ? ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", oldRev, newRev]
    : ["diff-tree", "--numstat", "-z", "--root", "-r", "--no-ext-diff", "--no-textconv", oldRev];
  const res = await exec(args, cwd);
  if (!res.ok) return undefined;
  return parseNumstatZ(res.stdout);
}

export interface GitChangesSession {
  /** Revision the session's work tree currently diffs against. */
  readonly rev: string | undefined;
  /** True once the session has a content reference (its first successful read). */
  readonly tracking: boolean;
  /** Successful reads that fed the churn totals. */
  readonly observations: number;
  /** Work tree vs HEAD right now — the number `git diff --numstat` prints, for
   * reconciling the churn totals against the repository by hand. */
  readonly state: ChangeCounts;
}

export interface GitChangesTracker {
  /** Latest session churn; undefined = not a repo / nothing read yet. */
  snapshot(): GitChangeStat | undefined;
  /** Refresh now; concurrent calls coalesce onto the in-flight read. */
  refresh(): Promise<void>;
  /** Activity signal (agent/tool work): debounced refresh while armed. */
  touch(): void;
  /** Arm the interval (idempotent; TUI sessions only). */
  start(): void;
  /** Disarm, forget the totals and the content references, drop the temp store. */
  dispose(): void;
  /** Diagnostics: what the session is diffing against and what it has churned. */
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
  /** Where the session-private object store is created (tests pin it). */
  tempRoot?: string;
}): GitChangesTracker {
  const intervalMs = deps.intervalMs ?? GIT_CHANGES_INTERVAL_MS;
  const debounceMs = deps.debounceMs ?? GIT_CHANGES_DEBOUNCE_MS;
  const now = deps.now ?? (() => Date.now());
  const lineCounts = deps.lineCounts ?? createLineCountCache();
  const exec = deps.exec ?? defaultExec;

  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  /** Session churn totals (absolute, monotone between resets). */
  let totals: ChangeCounts = { additions: 0, deletions: 0 };
  let contributors = new Set<string>();
  let current: GitChangeStat | undefined;
  /** Content reference per path: what this session last saw. */
  let observed = new Map<string, PathSnapshot>();
  /** True once a read has established this work tree's reference. Until then the
   * work tree is only photographed — work that predates the session is not the
   * session's churn (a fresh session in a dirty tree still starts at +0 −0). */
  let primed = false;
  /** HEAD at the last read (a move folds the committed delta out of the totals). */
  let observedRev: string | undefined;
  let rev: string | undefined;
  let revCwd: string | undefined;
  let observations = 0;
  let lastState: ChangeCounts = { additions: 0, deletions: 0 };
  let lastReadAt = 0;
  let lastReadMs = 0;
  let generation = 0;
  /** Session-private object store for hashed content (never the user's .git). */
  let objectDir: string | undefined;
  let emptyBlob: string | undefined;

  /** Drop the temp object store (dispose, /cd, no-repo). */
  const dropObjectDir = (): void => {
    const dir = objectDir;
    objectDir = undefined;
    emptyBlob = undefined;
    if (dir !== undefined) void rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
  };

  const forget = (): void => {
    totals = { additions: 0, deletions: 0 };
    observed = new Map();
    observedRev = undefined;
    primed = false;
    observations = 0;
    lastState = { additions: 0, deletions: 0 };
    contributors.clear();
    current = undefined;
  };

  /** Lazily create the private object store (undefined when the OS refuses). */
  const ensureObjectDir = async (): Promise<string | undefined> => {
    if (objectDir !== undefined) return objectDir;
    try {
      objectDir = await mkdtemp(join(deps.tempRoot ?? tmpdir(), "pi-codex-churn-"));
    } catch {
      objectDir = undefined;
    }
    return objectDir;
  };

  /** Blob id of the empty file, for paths that appeared or disappeared. */
  const emptyBlobId = async (cwd: string): Promise<string | undefined> => {
    if (emptyBlob !== undefined) return emptyBlob;
    const dir = await ensureObjectDir();
    if (dir === undefined) return undefined;
    const path = join(dir, "empty");
    try {
      await writeFile(path, "");
    } catch {
      return undefined;
    }
    const res = await exec(["hash-object", "-w", "--no-filters", "--", path], cwd, { GIT_OBJECT_DIRECTORY: dir });
    const blob = res.stdout.trim();
    if (!res.ok || !blob) return undefined;
    emptyBlob = blob;
    return blob;
  };

  /** Hash one work-tree file into the private store (content read by git). */
  const hashPath = async (cwd: string, path: string): Promise<string | undefined> => {
    const dir = await ensureObjectDir();
    if (dir === undefined) return undefined;
    const res = await exec(["hash-object", "-w", "--no-filters", "--", path], cwd, { GIT_OBJECT_DIRECTORY: dir });
    const blob = res.stdout.trim();
    return res.ok && blob ? blob : undefined;
  };

  /** Exact churn between two contents already in the private store. */
  const diffBlobs = async (cwd: string, from: string, to: string): Promise<ChangeCounts | undefined> => {
    const dir = objectDir;
    if (dir === undefined) return undefined;
    const res = await exec(["diff", "--numstat", from, to], cwd, { GIT_OBJECT_DIRECTORY: dir });
    if (!res.ok) return undefined;
    let additions = 0;
    let deletions = 0;
    for (const counts of parseNumstatZ(res.stdout).values()) {
      additions += counts.additions;
      deletions += counts.deletions;
    }
    return { additions, deletions };
  };

  /** Work-tree stat of one path (undefined = not a readable file). */
  const statInfo = async (cwd: string, path: string): Promise<{ size: number; mtimeMs: number } | undefined> => {
    try {
      const stats = await stat(join(cwd, path));
      return stats.isFile() ? { size: stats.size, mtimeMs: stats.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  };

  /** Add one path's churn to the totals and to the contributor set. */
  const add = (path: string, counts: ChangeCounts): void => {
    if (counts.additions === 0 && counts.deletions === 0) return;
    totals = { additions: totals.additions + counts.additions, deletions: totals.deletions + counts.deletions };
    contributors.add(path);
  };

  /**
   * Fold one read into the session totals. A path contributes the exact churn
   * between the content the session last saw and the content it sees now; a path
   * whose content cannot be referenced (an unhashable file) falls back to the
   * growth of its state counts, so a failure can never count a path twice.
   * `counting` is false for the session's reference read: that read only records
   * what the work tree already contained.
   */
  const observe = async (cwd: string, sample: ChangeSample, counting: boolean): Promise<void> => {
    const paths = new Set<string>([...sample.tracked.keys(), ...sample.untracked.keys(), ...observed.keys()]);
    for (const path of paths) {
      const previous = observed.get(path);
      const info = await statInfo(cwd, path);
      const currentCounts = sample.tracked.get(path) ?? { additions: sample.untracked.get(path) ?? 0, deletions: 0 };
      // An untouched path is skipped: same work-tree state AND same diff counts
      // (the counts also catch an edit whose size and mtime did not move).
      if (previous && samePathState(previous, info) && sameCounts(previous.counts, currentCounts)) continue;
      const remember = (blob: string): void => {
        setSnapshot(observed, path, {
          blob,
          missing: !info,
          size: info?.size ?? 0,
          mtimeMs: info?.mtimeMs ?? 0,
          counts: currentCounts,
        });
      };

      if (previous?.blob === "") {
        // Content was never referenceable: count how far its counts moved.
        if (counting) add(path, countsGrowth(previous.counts, currentCounts));
        remember("");
        continue;
      }

      const blob = info ? await hashPath(cwd, path) : await emptyBlobId(cwd);
      if (blob === undefined) {
        // Not referenceable right now: a known path keeps its reference and is
        // picked up on a later read; a new one starts from its counts.
        if (previous) continue;
        if (counting) add(path, currentCounts);
        remember("");
        continue;
      }

      if (previous) {
        const counts = await diffBlobs(cwd, previous.blob, blob);
        if (counts === undefined) continue; // keep the old reference, capture it next read
        add(path, counts);
      } else if (counting) {
        // First sighting after the reference read: the path was clean then, so
        // what it carries now is this session's churn.
        add(path, currentCounts);
      }
      remember(blob);
    }
  };

  const publish = (): boolean => {
    const next: GitChangeStat = { additions: totals.additions, deletions: totals.deletions, files: contributors.size };
    const changed = !sameStat(current, next);
    current = next;
    return changed;
  };

  const run = async (gen: number): Promise<void> => {
    const cwd = deps.getCwd();
    if (cwd !== revCwd) {
      // A new work tree (session /cd): new reference, new totals, new store.
      revCwd = cwd;
      dropObjectDir();
      forget();
      lineCounts.clear();
    }

    const started = now();
    const nextRev = await resolveSessionRev(cwd, deps);
    if (gen !== generation) return;

    const result = await readChangeSample(cwd, { exec, lineCounts, rev: nextRev });
    if (gen !== generation) return;

    if (result.kind === "error") {
      lastReadMs = now() - started;
      lastReadAt = now();
      return; // keep the last good totals
    }
    if (result.kind === "no-repo") {
      const changed = current !== undefined;
      dropObjectDir();
      forget();
      if (changed) deps.onUpdate?.();
      lastReadMs = now() - started;
      lastReadAt = now();
      return;
    }

    // HEAD moved (commit / amend / rebase / pull): the committed delta stops
    // being this session's churn. The content references stay valid — a commit
    // does not change the work tree, only which revision it is compared with.
    if (observedRev !== nextRev) {
      if (observedRev !== undefined) {
        const committed = await committedDelta(exec, cwd, observedRev, nextRev);
        if (gen !== generation) return;
        if (committed) {
          for (const counts of committed.values()) totals = foldCommitted(totals, counts);
          if (totals.additions === 0 && totals.deletions === 0) contributors.clear();
        }
      }
      observedRev = nextRev;
    }
    rev = nextRev;

    await observe(cwd, result.sample, primed);
    if (gen !== generation) return;
    primed = true;
    observations += 1;
    lastState = sampleTotals(result.sample);

    // A clean work tree (no diffs, no untracked files) means the session's work
    // is committed or gone: the totals go back to zero (0.15.4). The stat is
    // still published as +0 −0, so "clean" never reads as "unavailable".
    if (result.sample.tracked.size === 0 && result.sample.untracked.size === 0) {
      forget();
      // The tree is clean, so what appears later is the session's own churn:
      // keep the reference established instead of re-photographing the tree.
      primed = true;
      const changed = publish();
      lastReadMs = now() - started;
      lastReadAt = now();
      if (changed) deps.onUpdate?.();
      return;
    }

    const changed = publish();
    lastReadMs = now() - started;
    lastReadAt = now();
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
      // The debounce already spaces fast reads; a SLOW read (git or content
      // hashing that takes seconds) additionally holds the next one off for
      // twice its own duration, so activity can never queue work back to back.
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
      dropObjectDir();
      forget();
      revCwd = undefined;
      rev = undefined;
      lineCounts.clear();
    },
    session: () => ({ rev, tracking: observedRev !== undefined, observations, state: lastState }),
    get running() {
      return timer !== undefined;
    },
  };
}

/** Line totals of one sample: the repository's uncommitted delta right now. */
function sampleTotals(sample: ChangeSample): ChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const counts of sample.tracked.values()) {
    additions += counts.additions;
    deletions += counts.deletions;
  }
  for (const lines of sample.untracked.values()) additions += lines;
  return { additions, deletions };
}

/** Store a content reference, keeping the map bounded (FIFO on overflow). */
function setSnapshot(observed: Map<string, PathSnapshot>, path: string, snapshot: PathSnapshot): void {
  observed.delete(path);
  if (observed.size >= MAX_OBSERVED_PATHS) {
    const oldest = observed.keys().next().value;
    if (oldest !== undefined) observed.delete(oldest);
  }
  observed.set(path, snapshot);
}
