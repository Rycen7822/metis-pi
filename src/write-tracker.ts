// Ephemeral write tracking (Codex file-change pre/post images).
//
// tool_execution_start captures the pre-image of the target path for EXACT
// builtin `write` ownership only; tool_execution_end verifies the post-image.
// Everything is held in-process memory only (no persistence, no tool result
// modification). When a reliable diff cannot be produced the tracker returns
// an explicit fallback — it never fabricates one.

import * as fs from "node:fs";

export interface WriteSnapshot {
  readonly existed: boolean;
  readonly content: string | null;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface WriteDiff {
  readonly kind: "add" | "update" | "unavailable";
  readonly diff?: string;
  readonly added: number;
  readonly removed: number;
  readonly reason?: string;
}

/** Guardrails mirror Codex's highlight limits. */
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  for (const byte of probe) if (byte === 0) return true;
  return false;
}

/** Read the current file image (ephemeral, read-only). */
export function snapshotFile(absolutePath: string): WriteSnapshot {
  try {
    const stats = fs.statSync(absolutePath);
    if (!stats.isFile()) {
      return { existed: false, content: null, binary: false, truncated: false, error: "not a regular file" };
    }
    const buffer = fs.readFileSync(absolutePath);
    const binary = looksBinary(buffer);
    const truncated = buffer.length > MAX_SNAPSHOT_BYTES;
    return {
      existed: true,
      content: binary || truncated ? null : buffer.toString("utf8"),
      binary,
      truncated,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { existed: false, content: null, binary: false, truncated: false };
    // EACCES/EISDIR/...: pre-image is unreadable; tracking must fail closed.
    return { existed: false, content: null, binary: false, truncated: false, error: code ?? "unreadable" };
  }
}

/** Exact builtin write ownership: toolName === "write" and string args. */
export function isTrackableWrite(toolName: string, args: unknown): args is { path: string; content: string } {
  if (toolName !== "write") return false;
  const record = args as Record<string, unknown> | null;
  return record !== null
    && typeof record === "object"
    && typeof record.path === "string"
    && typeof record.content === "string";
}

function countLines(text: string): number {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

/** Classic LCS-free unified diff on lines ( Myers too heavy for TUI paths). */
/**
 * Line diff in Pi display-diff format with line numbers:
 *   context: "  N text"   (N = new-side line number)
 *   removal: "- N text"   (N = old-side line number)
 *   insertion: "+ N text" (N = new-side line number)
 *   gap between context windows: "     ..."
 */
export function diffLines(before: readonly string[], after: readonly string[]): string {
  const context = 3;
  // Common prefix/suffix trimming keeps the LCS table small.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const oldMiddle = before.slice(start, endBefore);
  const newMiddle = after.slice(start, endAfter);

  // LCS table over the (bounded) edit window.
  const n = oldMiddle.length;
  const m = newMiddle.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = oldMiddle[i] === newMiddle[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  type Op = { sign: " " | "-" | "+"; oldLine?: number; newLine?: number; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldMiddle[i] === newMiddle[j]) {
      ops.push({ sign: " ", oldLine: start + i + 1, newLine: start + j + 1, text: oldMiddle[i]! });
      i += 1; j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ sign: "-", oldLine: start + i + 1, text: oldMiddle[i]! });
      i += 1;
    } else {
      ops.push({ sign: "+", newLine: start + j + 1, text: newMiddle[j]! });
      j += 1;
    }
  }
  while (i < n) { ops.push({ sign: "-", oldLine: start + i + 1, text: oldMiddle[i]! }); i += 1; }
  while (j < m) { ops.push({ sign: "+", newLine: start + j + 1, text: newMiddle[j]! }); j += 1; }

  // Keep a context window around every change; gaps render as "...".
  const keep = ops.map((op) => op.sign !== " ");
  ops.forEach((_, index) => {
    if (!keep[index]) return;
    for (let offset = 1; offset <= context; offset++) {
      if (index - offset >= 0) keep[index - offset] = true;
      if (index + offset < ops.length) keep[index + offset] = true;
    }
  });

  // Leading context before the window (with correct old/new numbering).
  const rows: string[] = [];
  const windowStart = ops.findIndex((_, index) => keep[index]);
  if (windowStart > 0) {
    // Not possible: windowStart is the first kept op; leading ops before it are
    // within the same op stream. Context from the untouched prefix instead.
  }
  if (start > 0) {
    for (let index = Math.max(0, start - context); index < start; index++) {
      rows.push(`  ${index + 1} ${before[index]}`);
    }
  }
  let lastKept = -2;
  for (let index = 0; index < ops.length; index++) {
    if (!keep[index]) continue;
    if (lastKept >= 0 && index - lastKept > 1) rows.push("     ...");
    const op = ops[index]!;
    if (op.sign === " ") rows.push(`  ${op.newLine} ${op.text}`);
    else if (op.sign === "-") rows.push(`- ${op.oldLine} ${op.text}`);
    else rows.push(`+ ${op.newLine} ${op.text}`);
    lastKept = index;
  }
  if (endBefore < before.length) {
    for (let index = endBefore; index < Math.min(before.length, endBefore + context); index++) {
      rows.push(`  ${index + 1} ${before[index]}`);
    }
  }
  return rows.join("\n");
}

/**
 * Produce the presentation diff for a completed write. Honest by contract:
 * any uncertainty returns kind "unavailable" with a human-readable reason.
 */
export function computeWriteDiff(pre: WriteSnapshot | undefined, postContent: string): WriteDiff {
  if (!pre) return { kind: "unavailable", added: 0, removed: 0, reason: "no pre-image captured" };
  if (pre.error) return { kind: "unavailable", added: 0, removed: 0, reason: `pre-image unreadable (${pre.error})` };
  if (pre.binary) return { kind: "unavailable", added: 0, removed: 0, reason: "existing file is binary" };
  if (pre.truncated) return { kind: "unavailable", added: 0, removed: 0, reason: "existing file too large to diff" };
  if (!pre.existed) {
    return { kind: "add", diff: undefined, added: countLines(postContent), removed: 0 };
  }
  const before = pre.content ?? "";
  if (before === postContent) {
    return { kind: "update", diff: "", added: 0, removed: 0 };
  }
  const diff = diffLines(before.split("\n"), postContent.split("\n"));
  const rows = diff ? diff.split("\n") : [];
  return {
    kind: "update",
    diff,
    added: rows.filter((row) => row.startsWith("+ ")).length,
    removed: rows.filter((row) => row.startsWith("- ")).length,
  };
}

/**
 * Ephemeral per-session tracker. Keys are toolCallIds; entries are dropped at
 * tool end (and bounded to avoid growth on long sessions).
 */
export class WriteDiffTracker {
  readonly #pending = new Map<string, { absolutePath: string; pre: WriteSnapshot }>();
  #clock = 0;
  readonly #order = new Map<string, number>();
  static readonly MAX_PENDING = 64;

  /** Capture the pre-image. Ignores non-builtin write calls by contract. */
  trackStart(toolCallId: string, toolName: string, args: unknown, resolvePath: (path: string) => string): void {
    if (!isTrackableWrite(toolName, args)) return;
    if (this.#pending.has(toolCallId)) return; // parallel duplicate id: first wins
    const absolutePath = resolvePath(args.path);
    this.#pending.set(toolCallId, { absolutePath, pre: snapshotFile(absolutePath) });
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
  trackEnd(toolCallId: string, toolName: string, isError: boolean): WriteDiff | undefined {
    const entry = this.#pending.get(toolCallId);
    this.#pending.delete(toolCallId);
    this.#order.delete(toolCallId);
    if (!entry || toolName !== "write") return undefined;
    if (isError) return { kind: "unavailable", added: 0, removed: 0, reason: "write failed" };
    let post: WriteSnapshot;
    try {
      post = snapshotFile(entry.absolutePath);
    } catch {
      post = { existed: false, content: null, binary: false, truncated: false, error: "unreadable" };
    }
    if (post.error) return { kind: "unavailable", added: 0, removed: 0, reason: `post-image unreadable (${post.error})` };
    if (post.binary) return { kind: "unavailable", added: 0, removed: 0, reason: "written file is binary" };
    if (post.truncated) return { kind: "unavailable", added: 0, removed: 0, reason: "written file too large to diff" };
    if (!post.existed || post.content === null) {
      return { kind: "unavailable", added: 0, removed: 0, reason: "post-write mismatch (file missing)" };
    }
    return computeWriteDiff(entry.pre, post.content);
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
