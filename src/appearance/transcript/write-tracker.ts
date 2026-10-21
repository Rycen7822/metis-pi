// Session-owned observation of builtin write lifecycle events.
import { snapshotFile, computeWriteDiff, type WriteSnapshot, type WriteDiff } from "../../file-changes/diff.ts";

/**
 * Exact builtin write ownership. The tool entry must carry Pi's builtin
 * sourceInfo; a same-named tool from any extension never qualifies.
 */
export function isTrackableWrite(toolName: string, args: unknown, sourceInfo?: unknown): args is { path: string; content: string } {
  if (toolName !== "write") return false;
  const info = (sourceInfo ?? {}) as Record<string, unknown>;
  if (info.source !== "builtin" || info.path !== "builtin:write") return false;
  const record = args as Record<string, unknown> | null;
  return record !== null
    && typeof record === "object"
    && typeof record.path === "string"
    && typeof record.content === "string";
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
  static readonly MAX_PENDING = 64;

  /** Capture the pre-image. Ignores non-builtin write calls by contract. */
  trackStart(toolCallId: string, toolName: string, args: unknown, sourceInfo: unknown, resolvePath: (path: string) => string): void {
    if (!isTrackableWrite(toolName, args, sourceInfo)) return;
    if (this.#pending.has(toolCallId)) return; // parallel duplicate id: first wins
    const absolutePath = resolvePath(args.path);
    this.#pending.delete(toolCallId);
    this.#pending.set(toolCallId, {
      absolutePath,
      pre: snapshotFile(absolutePath),
      expectedContent: args.content,
    });
    if (this.#pending.size > WriteDiffTracker.MAX_PENDING) {
      this.#pending.delete(this.#pending.keys().next().value!);
    }
  }

  /** Consume the pre-image and diff against the written content. */
  trackEnd(toolCallId: string, toolName: string, sourceInfo: unknown, isError: boolean): WriteDiff | undefined {
    const entry = this.#pending.get(toolCallId);
    this.#pending.delete(toolCallId);
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
