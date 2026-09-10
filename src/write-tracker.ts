// Ephemeral write tracking (Codex file-change pre/post images).
//
// tool_execution_start captures the pre-image of the target path for EXACT
// builtin `write` ownership (sourceInfo.source === "builtin" AND
// sourceInfo.path === "<builtin:write>"); tool_execution_end verifies the
// post-image byte-for-byte against the call's own expected content. Everything
// is held in-process memory only (no persistence, no tool result
// modification). When a reliable diff cannot be produced the tracker returns
// an explicit fallback — it never fabricates one.

import * as fs from "node:fs";
import type { DiffRow } from "./diff.ts";

export interface WriteSnapshot {
  readonly existed: boolean;
  readonly content: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly error?: string;
}

export type WriteChangeKind = "add" | "update" | "unchanged" | "unavailable" | "failed";

export interface WriteDiff {
  readonly kind: WriteChangeKind;
  /** Structured rows for the diff renderer (add: all-insert; update: hunks). */
  readonly rows?: readonly DiffRow[];
  readonly added: number;
  readonly removed: number;
  readonly reason?: string;
}

/** Guardrails: bounded reads and bounded diffs (Codex highlight limits). */
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MAX_DIFF_LINES = 10_000;
const DIFF_CONTEXT = 3;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  for (const byte of probe) if (byte === 0) return true;
  return false;
}

/**
 * Read the current file image (ephemeral, read-only). Size is checked BEFORE
 * reading; reads are bounded to MAX_SNAPSHOT_BYTES and growth between stat
 * and read cannot over-allocate.
 */
export function snapshotFile(absolutePath: string): WriteSnapshot {
  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) {
      return { existed: true, content: null, binary: false, truncated: false, error: "not a regular file" };
    }
    if (stats.size > MAX_SNAPSHOT_BYTES) {
      return { existed: true, content: null, binary: false, truncated: true };
    }
    const buffer = readBounded(absolutePath, MAX_SNAPSHOT_BYTES);
    if (buffer.length > MAX_SNAPSHOT_BYTES) {
      return { existed: true, content: null, binary: false, truncated: true };
    }
    const binary = looksBinary(buffer);
    return {
      existed: true,
      content: binary ? null : buffer.toString("utf8"),
      binary,
      truncated: false,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { existed: false, content: null, binary: false, truncated: false };
    // EACCES/EISDIR/...: pre-image is unreadable; tracking must fail closed.
    return { existed: false, content: null, binary: false, truncated: false, error: code ?? "unreadable" };
  }
}

function readBounded(absolutePath: string, limit: number): Buffer {
  const fd = fs.openSync(absolutePath, "r");
  try {
    // One extra byte detects growth between stat and read.
    const buffer = Buffer.alloc(limit + 1);
    const read = fs.readSync(fd, buffer, 0, limit + 1, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Exact builtin write ownership. The tool entry must carry Pi's builtin
 * sourceInfo; a same-named tool from any extension never qualifies.
 */
export function isTrackableWrite(toolName: string, args: unknown, sourceInfo?: unknown): args is { path: string; content: string } {
  if (toolName !== "write") return false;
  const info = (sourceInfo ?? {}) as Record<string, unknown>;
  if (info.source !== "builtin" || info.path !== "<builtin:write>") return false;
  const record = args as Record<string, unknown> | null;
  return record !== null
    && typeof record === "object"
    && typeof record.path === "string"
    && typeof record.content === "string";
}

/** Split into display lines; a trailing newline does not create a phantom line. */
function toLines(text: string): string[] {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed === "" ? [] : trimmed.split("\n");
}

function normalizeLf(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text.replace(/\r(?!\n)/g, "\n");
}

export interface DiffBudget { ok: boolean }

function withinDiffBudget(before: readonly string[], after: readonly string[]): boolean {
  const totalLines = before.length + after.length;
  if (totalLines > MAX_DIFF_LINES) return false;
  let bytes = 0;
  for (const line of before) bytes += line.length + 1;
  for (const line of after) bytes += line.length + 1;
  return bytes <= MAX_SNAPSHOT_BYTES * 2;
}

interface HunkOp {
  readonly sign: " " | "-" | "+";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

/**
 * Zero-dependency Myers diff (the "diff" npm package is NOT installable in
 * Pi's git-clone extension layout — a bare import there breaks extension
 * loading entirely). Bounded by withinDiffBudget, so the O((N+M)·D) search
 * stays small; anything bigger never reaches this function.
 * Returns operations in document order: " ", "-", "+".
 */
function diffLineOps(before: readonly string[], after: readonly string[]): HunkOp[] {
  const n = before.length;
  const m = after.length;
  // Trim common prefix/suffix so the search works on the changed middle.
  let start = 0;
  while (start < n && start < m && before[start] === after[start]) start += 1;
  let endBefore = n;
  let endAfter = m;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const ops: HunkOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ sign: " ", oldLine: i + 1, newLine: i + 1, text: before[i]! });
  const midBefore = before.slice(start, endBefore);
  const midAfter = after.slice(start, endAfter);

  if (midBefore.length === 0 || midAfter.length === 0) {
    // One-sided middle: number directly (old lines consume oldCursor, new
    // lines consume newCursor — the same counters the Myers path uses).
    let oldCursor = start;
    let newCursor = start;
    for (const text of midBefore) {
      ops.push({ sign: "-", oldLine: oldCursor + 1, text });
      oldCursor += 1;
    }
    for (const text of midAfter) {
      ops.push({ sign: "+", newLine: newCursor + 1, text });
      newCursor += 1;
    }
  } else {
    // Myers O(ND) on the middle. V is indexed by k = -D..D (offset by max).
    const max = midBefore.length + midAfter.length;
    const offset = max;
    const v = new Int32Array(2 * max + 1);
    const trace: Int32Array[] = [];
    let foundD = -1;
    search: for (let d = 0; d <= max; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
          x = v[offset + k + 1]!;
        } else {
          x = v[offset + k - 1]! + 1;
        }
        let y = x - k;
        while (x < midBefore.length && y < midAfter.length && midBefore[x] === midAfter[y]) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= midBefore.length && y >= midAfter.length) {
          foundD = d;
          break search;
        }
      }
    }
    if (foundD < 0) {
      // Budget guard made this unreachable; fail safe to "unavailable".
      return ops;
    }
    // Backtrack the shortest edit script into a list of middle ops.
    const middle: Array<{ sign: "-" | "+" | " "; index: number; text: string }> = [];
    let x = midBefore.length;
    let y = midAfter.length;
    for (let d = foundD; d > 0; d--) {
      const vPrev = trace[d]!;
      const k = x - y;
      let prevK: number;
      if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = vPrev[offset + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        middle.push({ sign: " ", index: x - 1, text: midBefore[x - 1]! });
        x -= 1;
        y -= 1;
      }
      if (prevK === k - 1) {
        middle.push({ sign: "-", index: x - 1, text: midBefore[x - 1]! });
        x -= 1;
      } else {
        middle.push({ sign: "+", index: y - 1, text: midAfter[y - 1]! });
        y -= 1;
      }
    }
    while (x > 0 && y > 0) {
      middle.push({ sign: " ", index: x - 1, text: midBefore[x - 1]! });
      x -= 1;
      y -= 1;
    }
    middle.reverse();
    // Renumber in document order: "-" consumes old lines, "+" consumes new
    // lines, " " consumes both. Interleaving keeps removals before insertions
    // at the same position (matches the previous jsdiff output shape).
    let oldCursor = start;
    let newCursor = start;
    const withNumbers: HunkOp[] = [];
    for (const op of middle) {
      if (op.sign === "-") {
        withNumbers.push({ sign: "-", oldLine: oldCursor + 1, text: op.text });
        oldCursor += 1;
      } else if (op.sign === "+") {
        withNumbers.push({ sign: "+", newLine: newCursor + 1, text: op.text });
        newCursor += 1;
      } else {
        withNumbers.push({ sign: " ", oldLine: oldCursor + 1, newLine: newCursor + 1, text: op.text });
        oldCursor += 1;
        newCursor += 1;
      }
    }
    ops.push(...withNumbers);
  }
  // Trailing common suffix.
  let oldLine = endBefore;
  let newLine = endAfter;
  while (oldLine < n && newLine < m) {
    ops.push({ sign: " ", oldLine: oldLine + 1, newLine: newLine + 1, text: before[oldLine]! });
    oldLine += 1;
    newLine += 1;
  }
  return ops;
}

/**
 * Build structured DiffRows with per-change context windows computed from
 * change indexes (no forward contagion; suffix context uses new-side numbers).
 */
export function buildDiffRows(beforeText: string, afterText: string): { rows: DiffRow[]; added: number; removed: number } | undefined {
  const before = toLines(normalizeLf(beforeText));
  const after = toLines(normalizeLf(afterText));
  if (!withinDiffBudget(before, after)) return undefined;

  const ops = diffLineOps(before, after);
  let oldLine = 1;
  let newLine = 1;

  // Context windows from change indexes: mark, then merge intervals.
  const changeIndexes = ops.map((op, index) => op.sign !== " " ? index : -1).filter((index) => index >= 0);
  const intervals: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - DIFF_CONTEXT);
    const end = Math.min(ops.length - 1, index + DIFF_CONTEXT);
    const last = intervals.at(-1);
    if (last && start <= last[1]! + 1) last[1] = Math.max(last[1]!, end);
    else intervals.push([start, end]);
  }

  const rows: DiffRow[] = [];
  let previousEnd = -1;
  for (const [start, end] of intervals) {
    if (previousEnd >= 0 && start > previousEnd + 1) {
      rows.push({ kind: "separator", content: "…" });
    }
    for (let index = start; index <= end; index++) {
      const op = ops[index]!;
      if (op.sign === " ") {
        rows.push({ kind: "context", newNumber: op.newLine, lineNumber: op.newLine, content: op.text });
      } else if (op.sign === "-") {
        rows.push({ kind: "remove", oldNumber: op.oldLine, lineNumber: op.oldLine, content: op.text });
      } else {
        rows.push({ kind: "add", newNumber: op.newLine, lineNumber: op.newLine, content: op.text });
      }
    }
    previousEnd = end;
  }
  return {
    rows,
    added: ops.filter((op) => op.sign === "+").length,
    removed: ops.filter((op) => op.sign === "-").length,
  };
}

/** All-insert rows for a new file (Codex FileChange::Add). */
export function buildAddRows(content: string): readonly DiffRow[] {
  const lines = toLines(normalizeLf(content));
  return lines.map((text, index) => ({ kind: "add" as const, newNumber: index + 1, lineNumber: index + 1, content: text }));
}

/**
 * Produce the presentation diff for a completed write. Honest by contract:
 * any uncertainty returns kind "unavailable" with a human-readable reason.
 * `expectedContent` is the call's own args.content; the post-image must match
 * it exactly or the result is marked unverified.
 */
export function computeWriteDiff(
  pre: WriteSnapshot | undefined,
  post: WriteSnapshot,
  expectedContent: string | undefined,
): WriteDiff {
  if (!pre) return { kind: "unavailable", added: 0, removed: 0, reason: "no pre-image captured" };
  if (pre.error) return { kind: "unavailable", added: 0, removed: 0, reason: `pre-image unreadable (${pre.error})` };
  if (pre.binary) return { kind: "unavailable", added: 0, removed: 0, reason: "existing file is binary" };
  if (pre.truncated) return { kind: "unavailable", added: 0, removed: 0, reason: "existing file too large to diff" };
  if (post.error) return { kind: "unavailable", added: 0, removed: 0, reason: `post-image unreadable (${post.error})` };
  if (post.binary) return { kind: "unavailable", added: 0, removed: 0, reason: "written file is binary" };
  if (post.truncated) return { kind: "unavailable", added: 0, removed: 0, reason: "written file too large to diff" };
  if (!post.existed || post.content === null) {
    return { kind: "unavailable", added: 0, removed: 0, reason: "post-write mismatch (file missing)" };
  }
  // Verify the post-image against THIS call's expected content. If something
  // else wrote to the path in between, do not present a diff as ours.
  if (expectedContent !== undefined && normalizeLf(post.content) !== normalizeLf(expectedContent)) {
    return { kind: "unavailable", added: 0, removed: 0, reason: "post-write mismatch (content changed by another writer)" };
  }
  if (!pre.existed) {
    return { kind: "add", rows: buildAddRows(expectedContent ?? post.content), added: toLines(expectedContent ?? post.content).length, removed: 0 };
  }
  const before = pre.content ?? "";
  if (normalizeLf(before) === normalizeLf(expectedContent ?? post.content)) {
    return { kind: "unchanged", rows: [], added: 0, removed: 0 };
  }
  const built = buildDiffRows(before, expectedContent ?? post.content);
  if (!built) {
    return { kind: "unavailable", added: 0, removed: 0, reason: "diff budget exceeded" };
  }
  return { kind: "update", rows: built.rows, added: built.added, removed: built.removed };
}

interface PendingWrite {
  readonly absolutePath: string;
  readonly pre: WriteSnapshot;
  readonly expectedContent: string;
}

/**
 * Ephemeral per-session tracker. Keys are toolCallIds; entries are dropped at
 * tool end (and bounded to avoid growth on long sessions).
 */
export class WriteDiffTracker {
  readonly #pending = new Map<string, PendingWrite>();
  #clock = 0;
  readonly #order = new Map<string, number>();
  static readonly MAX_PENDING = 64;

  /** Capture the pre-image. Ignores non-builtin write calls by contract. */
  trackStart(toolCallId: string, toolName: string, args: unknown, sourceInfo: unknown, resolvePath: (path: string) => string): void {
    if (!isTrackableWrite(toolName, args, sourceInfo)) return;
    if (this.#pending.has(toolCallId)) return; // parallel duplicate id: first wins
    const absolutePath = resolvePath(args.path);
    this.#pending.set(toolCallId, {
      absolutePath,
      pre: snapshotFile(absolutePath),
      expectedContent: args.content,
    });
    this.#order.set(toolCallId, this.#clock++);
    if (this.#pending.size > WriteDiffTracker.MAX_PENDING) {
      const oldest = [...this.#order.entries()]
        .sort(([, a], [, b]) => a - b)
        .find(([id]) => this.#pending.has(id))?.[0];
      if (oldest) {
        this.#pending.delete(oldest);
        this.#order.delete(oldest);
      }
    }
  }

  /** Consume the pre-image and diff against the written content. */
  trackEnd(toolCallId: string, toolName: string, sourceInfo: unknown, isError: boolean): WriteDiff | undefined {
    const entry = this.#pending.get(toolCallId);
    this.#pending.delete(toolCallId);
    this.#order.delete(toolCallId);
    if (!entry || toolName !== "write") return undefined;
    if (!isTrackableWrite(toolName, { path: "x", content: entry.expectedContent }, sourceInfo)) return undefined;
    if (isError) return { kind: "failed", added: 0, removed: 0, reason: "write failed" };
    let post: WriteSnapshot;
    try {
      post = snapshotFile(entry.absolutePath);
    } catch {
      post = { existed: false, content: null, binary: false, truncated: false, error: "unreadable" };
    }
    return computeWriteDiff(entry.pre, post, entry.expectedContent);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}

/** Resolve a tool path against the session cwd (mirrors Pi write tool). */
export function resolveWritePath(path: string, cwd: string): string {
  if (path.startsWith("/")) return path;
  return `${cwd.replace(/\/$/, "")}/${path}`;
}
