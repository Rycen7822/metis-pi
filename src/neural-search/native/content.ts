import type { FileFinderApi, GrepCursor, GrepOptions, GrepResult, Result } from "@ff-labs/fff-node";

export const MATCHES_PER_FILE = 200;
/** The native cursor skips whole files; retain an immutable batch and its next unread row. */
export interface ContentProgress { batch: GrepResult; offset: number; }

export function searchContent(
  finder: FileFinderApi, pattern: string | string[], constraints: string, options: GrepOptions,
): Result<GrepResult> {
  const { mode = "plain", ...shared } = options;
  if (Array.isArray(pattern) || mode === "plain" && !pattern.includes("\n")) {
    return finder.multiGrep({ ...shared, patterns: Array.isArray(pattern) ? pattern : [pattern], constraints: constraints || undefined });
  }
  const regex = mode === "plain" ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
  // A leading regex escape bypasses FFF's constraint parser. Optional word
  // boundary is zero-width and always succeeds; encode whitespace as one token.
  const encoded = regex.replace(/(\\*)\p{White_Space}/gu, (token, escapes: string) => {
    const char = token.at(-1)!;
    // An odd preceding escape already belongs to this whitespace atom.
    const prefix = escapes.slice(0, escapes.length - escapes.length % 2);
    return prefix + (char === "\n" ? "\\n" : `\\x{${char.codePointAt(0)!.toString(16)}}`);
  });
  const token = mode === "fuzzy" ? pattern : `\\b?(?:${encoded})`;
  const query = [constraints, token].filter(Boolean).join(" ");
  const found = finder.grep(query, { ...shared, mode: mode === "plain" ? "regex" : mode });
  if (found.ok && found.value.regexFallbackError) {
    const literal = finder.multiGrep({ ...shared, patterns: [pattern], constraints: constraints || undefined });
    if (literal.ok) literal.value.regexFallbackError = found.value.regexFallbackError;
    return literal;
  }
  return found;
}

export function contentPage(
  search: (cursor: GrepCursor | null) => Result<GrepResult>, limit: number, previous?: ContentProgress,
): { result: GrepResult; progress?: ContentProgress; cappedFiles: string[] } {
  const buffered = previous && previous.offset < previous.batch.items.length;
  const found = buffered ? { ok: true as const, value: previous.batch } : search(previous?.batch.nextCursor ?? null);
  if (!found.ok) throw new Error(found.error);
  const batch = found.value;
  const start = buffered ? previous.offset : 0;
  const items = batch.items.slice(start, start + limit);
  const offset = start + items.length;
  const counts = new Map<string, number>();
  for (const item of batch.items) counts.set(item.relativePath, (counts.get(item.relativePath) ?? 0) + 1);
  return {
    result: { ...batch, items, totalMatched: items.length },
    progress: offset < batch.items.length || batch.nextCursor ? { batch, offset } : undefined,
    cappedFiles: [...counts].filter(([, count]) => count >= MATCHES_PER_FILE).map(([file]) => file),
  };
}
