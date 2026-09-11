// Codex file-change model (FileChange): Add/Update/Delete rows feeding the diff renderer plus the "Added/Edited path (+N -M)" header format.

import { parseDisplayDiff, diffStatsFromRows, type DiffRow, type DiffStats } from "./diff.ts";

export type FileChangeKind = "add" | "update" | "delete";

export interface FileChange {
  readonly kind: FileChangeKind;
  readonly path: string;
  /** Unified diff text in Pi display format for update/delete. */
  readonly diff?: string;
  /** Full new content for add (rendered as all-insert rows). */
  readonly content?: string;
  readonly binary?: boolean;
  /** True when the diff could not be computed honestly. */
  readonly unavailable?: string;
}

export function changeVerb(kind: FileChangeKind): string {
  return kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Edited";
}

export function fileChangeStats(change: FileChange): DiffStats {
  if (change.kind === "add" && typeof change.content === "string" && !change.binary) {
    return { added: countLines(change.content), removed: 0 };
  }
  if (change.diff) {
    return diffStatsFromRows(parseDisplayDiff(change.diff));
  }
  return { added: 0, removed: 0 };
}

function countLines(content: string): number {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * Build all-insert rows for a new file (Codex FileChange::Add). Line numbers
 * follow the unified-diff dual numbering so the gutter shows new-side numbers.
 */
export function addFileRows(content: string): DiffRow[] {
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = text === "" ? [] : text.split("\n");
  return lines.map((line, index) => ({
    kind: "add" as const,
    newNumber: index + 1,
    content: line.replace(/\t/g, "    "),
  }));
}

export function unifiedDiffRows(diff: string): DiffRow[] {
  return parseDisplayDiff(diff);
}

export const hunkSeparatorRow: DiffRow = { kind: "metadata", content: "⋮" };
