// Working-tree change counts for the footer (+A −D). Display-only: it reads
// git and the work tree, never writes to the user's index, tree or object
// store, never throws, and reports nothing (rather than a wrong 0) when the
// data cannot be read.
//
// The numbers describe the work tree RIGHT NOW, relative to the current HEAD:
//
//   * one sample per read: `git diff --numstat HEAD` plus the untracked,
//     non-ignored text files. `git diff <rev>` compares the work tree — not the
//     index — with the revision, so staged and unstaged changes are both
//     included exactly once and never double-counted.
//   * additions and deletions are separate absolute counts, never a net delta
//     ("file grew by 3" is not "+3 −0").
//   * a repeated read of an unchanged tree reports the same numbers; nothing
//     accumulates. Committing or reverting lowers them on the next read.
//   * work in progress when the session starts shows immediately: there is no
//     session baseline and no content history to compare against.
//   * untracked, non-ignored files count their lines because git does not diff
//     them. Ignored files are not listed; binary or oversized untracked files
//     are skipped rather than counted as zero.
//   * an unborn HEAD (no commits yet) diffs against the empty tree, so staged
//     new files count their content like any change against a real HEAD.
//   * a failed git read keeps the last good numbers instead of showing 0, and
//     a failed HEAD lookup is not "no commits": only a HEAD that is still a
//     live symbolic ref without commits diffs against the empty tree.
//
// Bounded by design: two or three git processes per read (HEAD, diff, untracked
// list), ≤200 untracked files, ≤256 KiB streamed from each untracked file
// (counted in chunks, cached by size+mtime so an unchanged tree is not
// re-read), a 5s timeout on every git call, and a cwd without git metadata
// clears the stat without spawning git at all.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface GitChangeStat {
  /** Uncommitted additions in the work tree right now. */
  readonly additions: number;
  /** Uncommitted deletions in the work tree right now. */
  readonly deletions: number;
  /** Changed paths in the sample: tracked diff rows + counted untracked files. */
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
  /** Exit code when the command ran; null/absent for timeout, signal or spawn failure. */
  readonly code?: number | null;
}

export type GitExec = (args: readonly string[], cwd: string, env?: Record<string, string>) => Promise<GitExecResult>;
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

/** The empty tree's object id is fixed per hash algorithm. `git diff <rev>`
 * accepts it as a revision, so an unborn HEAD can be diffed like a real one. */
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

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
      (error, stdout) => resolvePromise({
        ok: !error,
        stdout: typeof stdout === "string" ? stdout : "",
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
      }),
    );
  });
}

export type ChangeReadResult =
  | { readonly kind: "sample"; readonly sample: ChangeSample }
  /** No git metadata in cwd: nothing to show. */
  | { readonly kind: "no-repo" }
  /** Git answered with an error or timed out: keep the previous numbers. */
  | { readonly kind: "error" };

/** What `resolveHead` learned. "error" is not "no commits": timeouts,
 * damaged refs and general git failures must not become an empty-tree baseline. */
export type HeadResolution =
  | { readonly kind: "head"; readonly rev: string }
  | { readonly kind: "unborn" }
  | { readonly kind: "error" };

/** HEAD right now: the revision the work tree diffs against. Re-resolved every
 * read so a commit is seen on the next poll. "unborn" (no commits yet) only
 * with positive evidence; any other failure is "error" and keeps the last good
 * numbers. */
export async function resolveHead(cwd: string, deps: { exec?: GitExec } = {}): Promise<HeadResolution> {
  const exec = deps.exec ?? defaultExec;
  const head = await exec(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
  const rev = head.stdout.trim();
  if (head.ok) return rev ? { kind: "head", rev } : { kind: "error" };
  // A silent exit 1 is the unborn case ONLY while HEAD is still a live symbolic
  // ref: an unborn branch resolves to nothing, while a damaged ref or a corrupt
  // HEAD file makes `symbolic-ref` fail (typically exit 128) or print nothing.
  if (head.code !== 1 || rev !== "") return { kind: "error" };
  const symref = await exec(["symbolic-ref", "--quiet", "HEAD"], cwd);
  if (!symref.ok || !symref.stdout.trim()) return { kind: "error" };
  return { kind: "unborn" };
}

/** Empty-tree revision for repos without a first commit. The object id depends
 * on the repository's hash algorithm, so the format is queried rather than
 * assumed; an unanswerable query yields undefined (caller reports an error, it
 * never guesses SHA-1 vs SHA-256). */
async function emptyTreeRev(exec: GitExec, cwd: string): Promise<string | undefined> {
  const format = await exec(["rev-parse", "--show-object-format"], cwd);
  if (!format.ok) return undefined;
  const value = format.stdout.trim();
  if (value === "sha1") return EMPTY_TREE_SHA1;
  if (value === "sha256") return EMPTY_TREE_SHA256;
  return undefined;
}

export interface ChangeReadDeps {
  exec?: GitExec;
  lineCounts?: LineCountCache;
  /** Revision to diff against, from resolveHead()'s "head" result. */
  rev?: string;
  /** Set only when resolveHead() returned "unborn": baseline on empty tree. */
  unborn?: boolean;
}

const sharedLineCounts = createLineCountCache();

/** One full read of the work tree relative to `rev`, or to the empty tree when
 * `unborn` carries resolveHead()'s positive unborn evidence. Without either,
 * this reports an error instead of guessing a baseline: a HEAD lookup that
 * failed transiently must never turn every file into an addition. */
export async function readChangeSample(cwd: string, deps: ChangeReadDeps = {}): Promise<ChangeReadResult> {
  if (!findGitDir(cwd)) return { kind: "no-repo" };
  const exec = deps.exec ?? defaultExec;
  const counts = deps.lineCounts ?? sharedLineCounts;

  let rev: string;
  if (typeof deps.rev === "string" && deps.rev !== "") {
    rev = deps.rev;
  } else if (deps.unborn === true) {
    const emptyTree = await emptyTreeRev(exec, cwd);
    if (emptyTree === undefined) return { kind: "error" };
    rev = emptyTree;
  } else {
    return { kind: "error" };
  }
  const tracked = await exec(["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", rev], cwd);
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

export interface GitChangesSession {
  /** Revision the last sample diffed against; undefined = unborn HEAD. */
  readonly rev: string | undefined;
  /** Successful samples published so far. */
  readonly observations: number;
}

export interface GitChangesTracker {
  /** Latest sample; undefined = no git metadata / no successful read yet. */
  snapshot(): GitChangeStat | undefined;
  /** Refresh now; concurrent calls coalesce onto the in-flight read. */
  refresh(): Promise<void>;
  /** Activity signal (agent/tool work): debounced refresh while armed. */
  touch(): void;
  /** Arm the interval (idempotent; TUI sessions only). */
  start(): void;
  /** Disarm and forget the sample. */
  dispose(): void;
  /** Diagnostics: the base revision of the last sample and how many ran. */
  session(): GitChangesSession;
  /** True while the interval is armed. */
  readonly running: boolean;
}

function sameStat(a: GitChangeStat | undefined, b: GitChangeStat | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.additions === b.additions && a.deletions === b.deletions && a.files === b.files;
}

/** Totals of one sample: the work tree's uncommitted delta right now. */
function statOf(sample: ChangeSample): GitChangeStat {
  let additions = 0;
  let deletions = 0;
  for (const counts of sample.tracked.values()) {
    additions += counts.additions;
    deletions += counts.deletions;
  }
  for (const lines of sample.untracked.values()) additions += lines;
  return { additions, deletions, files: sample.tracked.size + sample.untracked.size };
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
  const exec = deps.exec ?? defaultExec;

  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let current: GitChangeStat | undefined;
  let rev: string | undefined;
  let revCwd: string | undefined;
  let observations = 0;
  let lastReadAt = 0;
  let lastReadMs = 0;
  let generation = 0;

  const resetSample = (): void => {
    rev = undefined;
    observations = 0;
    lineCounts.clear();
  };

  /** Drop the published sample (no repo, cwd changed), keeping the renderer in step. */
  const clearSnapshot = (): void => {
    if (current !== undefined) {
      current = undefined;
      deps.onUpdate?.();
    }
  };

  const run = async (gen: number): Promise<void> => {
    const cwd = deps.getCwd();
    if (cwd !== revCwd) {
      // A new work tree (session /cd): the old numbers describe another repo.
      revCwd = cwd;
      resetSample();
      clearSnapshot();
    }

    const started = now();
    if (!findGitDir(cwd)) {
      // Not a repo: nothing to show, and no git process to spawn.
      lastReadMs = now() - started;
      lastReadAt = now();
      resetSample();
      clearSnapshot();
      return;
    }

    const head = await resolveHead(cwd, { exec });
    if (gen !== generation) return;
    if (head.kind === "error") {
      // A failed HEAD lookup is not "no commits": keep the last good sample.
      lastReadMs = now() - started;
      lastReadAt = now();
      return;
    }

    const result = await readChangeSample(cwd, {
      exec,
      lineCounts,
      ...(head.kind === "head" ? { rev: head.rev } : { unborn: true }),
    });
    if (gen !== generation) return;

    lastReadMs = now() - started;
    lastReadAt = now();

    if (result.kind === "error") return; // keep the last good numbers
    if (result.kind === "no-repo") {
      resetSample();
      clearSnapshot();
      return;
    }

    rev = head.kind === "head" ? head.rev : undefined;
    observations += 1;
    // Publish only real changes: an unchanged tree must not wake the renderer
    // (or anything else counting updates) once per poll.
    const next = statOf(result.sample);
    if (!sameStat(current, next)) {
      current = next;
      deps.onUpdate?.();
    }
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
      // The debounce already spaces fast reads; a SLOW read (git on a cold cache)
      // additionally holds the next one off for twice its own duration, so
      // activity can never queue work back to back.
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
      rev = undefined;
      revCwd = undefined;
      observations = 0;
      lineCounts.clear();
    },
    session: () => ({ rev, observations }),
    get running() {
      return timer !== undefined;
    },
  };
}
