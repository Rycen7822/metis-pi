import type { FileFinderApi, GrepCursor, GrepOptions, GrepResult, Result } from "@ff-labs/fff-node";

export const MATCHES_PER_FILE = 200;
/** The native cursor skips whole files; retain an immutable batch and its next unread row. */
export interface ContentProgress { batch: GrepResult; offset: number; }

export function searchContent(
  finder: FileFinderApi, pattern: string | string[], constraints: string, options: GrepOptions,
): Result<GrepResult> {
  const { mode = "plain", ...shared } = options;
  if (Array.isArray(pattern) || mode === "plain") return searchLiterals(finder, Array.isArray(pattern) ? pattern : [pattern], constraints, shared);
  const found = mode === "fuzzy"
    ? finder.grep([constraints, pattern].filter(Boolean).join(" "), { ...shared, mode })
    : searchRegex(finder, pattern, constraints, shared);
  if (!found.ok || !found.value.regexFallbackError) return found;
  const literal = searchLiterals(finder, [pattern], constraints, shared);
  if (literal.ok) literal.value.regexFallbackError = found.value.regexFallbackError;
  return literal;
}

function searchLiterals(finder: FileFinderApi, patterns: string[], constraints: string, options: GrepOptions): Result<GrepResult> {
  // FFF joins needles with LF; an embedded LF must use one escaped expression,
  // including on regex fallback, rather than silently becoming extra OR items.
  if (patterns.every(pattern => !pattern.includes("\n"))) return finder.multiGrep({ ...options, patterns, constraints: constraints || undefined });
  const expression = patterns.map(pattern => pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const found = searchRegex(finder, expression, constraints, options);
  return found.ok && found.value.regexFallbackError
    ? { ok: false, error: `Cannot encode multiline literal search: ${found.value.regexFallbackError}` } : found;
}

function searchRegex(finder: FileFinderApi, pattern: string, constraints: string, options: GrepOptions): Result<GrepResult> {
  // Leading regex escape bypasses FFF constraint parsing; optional word boundary
  // is zero-width and always succeeds. Keep the expression in one native token.
  const encoded = pattern.replace(/(\\*)\p{White_Space}/gu, (token, escapes: string) => {
    const char = token.at(-1)!;
    const prefix = escapes.slice(0, escapes.length - escapes.length % 2);
    return prefix + (char === "\n" ? "\\n" : `\\x{${char.codePointAt(0)!.toString(16)}}`);
  });
  return finder.grep([constraints, `\\b?(?:${encoded})`].filter(Boolean).join(" "), { ...options, mode: "regex" });
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
