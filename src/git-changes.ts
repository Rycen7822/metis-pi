// Working-tree change counts for the footer (+A −D). Display-only: it reads
// `git diff --numstat HEAD` (staged + unstaged, relative to HEAD) and counts
// the lines of untracked, non-ignored files. It never writes to the index or
// the work tree, never throws, and reports nothing (rather than a wrong 0)
// when the data cannot be read. Bounded by design: ≤200 untracked files and
// ≤256 KiB each are counted, so a pathological tree cannot stall a render; a
// cwd without git metadata clears the stat without spawning git at all.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitChangeStat {
  readonly additions: number;
  readonly deletions: number;
  /** Changed paths counted (tracked + untracked). */
  readonly files: number;
}

export interface GitExecResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export type GitExec = (args: readonly string[], cwd: string) => Promise<GitExecResult>;
/** Buffer (or undefined when it must not be counted) for one work-tree path. */
export type ReadChangeFile = (path: string) => Buffer | undefined;

export const GIT_CHANGES_INTERVAL_MS = 2_000;
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_BYTES = 262_144;
const BINARY_PROBE_BYTES = 8_192;

/** `<add>\t<del>\t<path>` rows from `git diff --numstat`; binary rows use "-"
 * and contribute a changed file but no line counts. */
export function parseNumstat(stdout: string): GitChangeStat {
  let additions = 0;
  let deletions = 0;
  let files = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [add, del] = line.split("\t");
    if (add === undefined || del === undefined) continue;
    files += 1;
    additions += Number.parseInt(add, 10) || 0;
    deletions += Number.parseInt(del, 10) || 0;
  }
  return { additions, deletions, files };
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

/** Default reader: size-guarded and binary-skipping; undefined = not counted. */
export function readChangeFile(path: string): Buffer | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return undefined;
    const buffer = readFileSync(path);
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) return undefined;
    return buffer;
  } catch {
    return undefined;
  }
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
      ["--no-optional-locks", ...args],
      { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolvePromise({ ok: !error, stdout: typeof stdout === "string" ? stdout : "" }),
    );
  });
}

export interface GitChangesDeps {
  exec?: GitExec;
  readFile?: ReadChangeFile;
}

/** One full read. undefined = no git metadata in cwd (show nothing). A failing
 * git command inside a repo degrades to the parts that did read. */
export async function readGitChanges(cwd: string, deps: GitChangesDeps = {}): Promise<GitChangeStat | undefined> {
  if (!findGitDir(cwd)) return undefined;
  const exec = deps.exec ?? defaultExec;
  const read = deps.readFile ?? readChangeFile;

  const tracked = await exec(["diff", "--numstat", "HEAD"], cwd);
  const stat: GitChangeStat = tracked.ok ? parseNumstat(tracked.stdout) : { additions: 0, deletions: 0, files: 0 };
  const untracked = await exec(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (!untracked.ok) return stat;

  let additions = stat.additions;
  let files = stat.files;
  for (const path of parseUntracked(untracked.stdout).slice(0, MAX_UNTRACKED_FILES)) {
    const buffer = read(join(cwd, path));
    if (!buffer) continue;
    additions += countLines(buffer.toString("utf8"));
    files += 1;
  }
  return { additions, deletions: stat.deletions, files };
}

export interface GitChangesTracker {
  /** Latest good stat; undefined = not a repo / nothing reported yet. */
  snapshot(): GitChangeStat | undefined;
  /** Refresh now; concurrent calls coalesce onto the in-flight read. */
  refresh(): Promise<void>;
  /** Arm the interval (idempotent; TUI sessions only). */
  start(): void;
  /** Disarm the interval and forget the stat. */
  dispose(): void;
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
  readFile?: ReadChangeFile;
  intervalMs?: number;
}): GitChangesTracker {
  const intervalMs = deps.intervalMs ?? GIT_CHANGES_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let current: GitChangeStat | undefined;
  let generation = 0;

  const run = async (gen: number): Promise<void> => {
    const next = await readGitChanges(deps.getCwd(), deps);
    if (gen !== generation) return; // disposed (or restarted) mid-read
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
      current = undefined;
    },
    get running() {
      return timer !== undefined;
    },
  };
}
