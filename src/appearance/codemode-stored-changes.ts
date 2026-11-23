import type { CodemodeStoreWrites } from "@earendil-works/pi-codemode";
import { buildDiffRows, type DiffRow } from "../file-changes/diff.ts";
import { safeText } from "../presentation/terminal-text.ts";
import { asRecord } from "../presentation/tool-names.ts";

const MAX_FILES = 8;
const MAX_LEGACY_BASES = 16;
const MAX_EDITS = 128;
const MAX_TEXT_CHARS = 262_144;
const MAX_MATCH_CHARS = 64 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 96 * 1024;

type Edit = { oldText: string; newText: string };
interface StoredChanges {
  path: string;
  rows?: DiffRow[];
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && value.trim() !== ""
    && !/[\x00-\x1f\x7f]/.test(value) && safeText(value) === value;
}

function isOriginal(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_CHARS;
}

function editsFrom(value: unknown): Edit[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > MAX_EDITS) return;
  const edits: Edit[] = [];
  for (const item of value) {
    const { oldText, newText } = asRecord(item);
    if (typeof oldText !== "string" || !oldText || typeof newText !== "string") return;
    edits.push({ oldText, newText });
  }
  return edits;
}

function applyExactEdits(original: string, edits: Edit[]): string | undefined {
  const matches: { start: number; end: number; newText: string }[] = [];
  let length = original.length;
  for (const { oldText, newText } of edits) {
    const start = original.indexOf(oldText);
    if (start < 0 || original.indexOf(oldText, start + 1) >= 0) return;
    matches.push({ start, end: start + oldText.length, newText });
    length += newText.length - oldText.length;
  }
  if (length > MAX_TEXT_CHARS) return;
  const parts: string[] = [];
  let end = 0;
  for (const match of matches.sort((a, b) => a.start - b.start)) {
    if (match.start < end) return;
    parts.push(original.slice(end, match.start), match.newText);
    end = match.end;
  }
  return parts.join("") + original.slice(end);
}

function legacyBases(initial: Readonly<Record<string, unknown>>, writes: CodemodeStoreWrites) {
  const deleted = new Set(writes.delete);
  const read = (key: string) => Object.hasOwn(writes.set, key) ? writes.set[key]
    : !deleted.has(key) && Object.hasOwn(initial, key) ? initial[key] : undefined;
  const bases: { path: string; original: string }[] = [];
  for (const keys of [Object.keys(writes.set), Object.keys(initial)]) {
    for (const key of keys) {
      if (key.length <= 5 || !key.endsWith("_path")) continue;
      const path = read(key), original = read(`${key.slice(0, -5)}_orig`);
      if (!isPath(path) || !isOriginal(original)) continue;
      if (bases.some(base => base.path === path && base.original === original)) continue;
      if (bases.length === MAX_LEGACY_BASES) return [];
      bases.push({ path, original });
    }
  }
  return bases;
}

/** Only called for successful native store receipts. No disk reads or JS source inference. */
export function captureStoredChanges(initial: Readonly<Record<string, unknown>>, writes: CodemodeStoreWrites): StoredChanges[] {
  let bases: ReturnType<typeof legacyBases> | undefined;
  const changes: StoredChanges[] = [];
  let matchBudget = MAX_MATCH_CHARS, previewBudget = MAX_PREVIEW_BYTES;
  for (const value of Object.values(writes.set)) {
    const { path, original, edits: explicitEdits } = asRecord(value);
    const edits = editsFrom(Array.isArray(value) ? value : explicitEdits);
    if (!edits) continue;
    const candidates = Array.isArray(value) ? bases ??= legacyBases(initial, writes)
      : isPath(path) && isOriginal(original) ? [{ path, original }] : [];
    let match: { path: string; original: string; after: string } | undefined;
    for (const base of candidates) {
      matchBudget -= base.original.length * edits.length * 2;
      if (matchBudget < 0) return changes;
      const after = applyExactEdits(base.original, edits);
      if (after === undefined) continue;
      if (match) { match = undefined; break; }
      match = { ...base, after };
    }
    if (!match || match.original === match.after) continue;
    const diff = previewBudget > 0 ? buildDiffRows(match.original, match.after) : undefined;
    const rows = diff?.rows.map(({ kind, lineNumber, content }) => ({ kind, lineNumber, content }));
    if (rows && !rows.length) rows.push({ kind: "metadata", lineNumber: undefined, content: "Only line endings changed." });
    const bytes = rows ? Buffer.byteLength(JSON.stringify(rows)) : 0;
    const change: StoredChanges = { path: match.path };
    if (rows && bytes <= previewBudget) { change.rows = rows; previewBudget -= bytes; }
    changes.push(change);
    if (changes.length === MAX_FILES) break;
  }
  return changes;
}

export function readStoredChanges(value: unknown): StoredChanges[] {
  if (!Array.isArray(value)) return [];
  const changes: StoredChanges[] = [];
  let remaining = MAX_PREVIEW_BYTES;
  for (const item of value.slice(0, MAX_FILES)) {
    const { path, rows } = asRecord(item);
    if (!isPath(path)) continue;
    const change: StoredChanges = { path };
    changes.push(change);
    if (!Array.isArray(rows) || rows.length > 10_000) continue;
    const parsed: DiffRow[] = [];
    for (const raw of rows) {
      const { kind, content, lineNumber } = asRecord(raw);
      if (typeof content !== "string" || content.length > remaining || /[\r\n]/.test(content)
        || (kind !== "context" && kind !== "add" && kind !== "remove" && kind !== "separator" && kind !== "metadata")) break;
      remaining -= Buffer.byteLength(content) + 32;
      if (remaining < 0) break;
      const number = typeof lineNumber === "number" && Number.isSafeInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined;
      parsed.push({ kind, content: safeText(content), lineNumber: number });
    }
    if (parsed.length && parsed.length === rows.length) change.rows = parsed;
  }
  return changes;
}
