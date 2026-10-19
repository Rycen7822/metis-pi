import type { FileFinderApi, GrepCursor, GrepOptions, GrepResult, Result } from "./binding/api.ts";

export const MATCHES_PER_FILE = 200;
export type ContentResult = GrepResult;
/** The native cursor skips whole files; retain an immutable batch and its next unread row. */
export interface ContentProgress { batch: ContentResult; offset: number; }

export function multilineOrError(patterns: readonly string[]): string | undefined {
  if (patterns.length > 1 && patterns.some(pattern => pattern.includes("\n")))
    return "Unsupported multi-pattern OR containing LF: native search cannot preserve individual hits and pagination. Split LF-containing literals into separate single-pattern queries.";
}

export function searchContent(
  finder: FileFinderApi, pattern: string | string[], constraints: string, options: GrepOptions,
): Result<ContentResult> {
  const { mode = "plain", ...shared } = options;
  if (Array.isArray(pattern) || mode === "plain") return searchLiterals(finder, Array.isArray(pattern) ? pattern : [pattern], constraints, shared);
  const found = mode === "fuzzy"
    ? finder.grep(pattern, { ...shared, mode, constraints })
    : finder.grep(pattern, { ...shared, mode: "regex", constraints });
  if (!found.ok || !found.value.regexFallbackError) return found;
  const literal = searchLiterals(finder, [pattern], constraints, shared);
  if (literal.ok) literal.value.regexFallbackError = found.value.regexFallbackError;
  return literal;
}

function searchLiterals(finder: FileFinderApi, patterns: string[], constraints: string, options: GrepOptions): Result<ContentResult> {
  const unsupported = multilineOrError(patterns);
  if (unsupported) return { ok: false, error: unsupported };
  // FFF joins needles with LF; a single LF-containing literal must use one
  // escaped expression, including on regex fallback, rather than extra OR items.
  if (patterns.every(pattern => !pattern.includes("\n"))) return finder.multiGrep({ ...options, patterns, constraints: constraints || undefined });
  // The guard leaves exactly one LF-containing literal here.
  const expression = patterns[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = finder.grep(expression, { ...options, mode: "regex", constraints });
  return found.ok && found.value.regexFallbackError
    ? { ok: false, error: `Cannot encode multiline literal search: ${found.value.regexFallbackError}` } : found;
}


export function contentPage(
  finder: FileFinderApi, search: (cursor: GrepCursor | null) => Result<ContentResult>, limit: number, previous?: ContentProgress,
): { result: ContentResult; progress?: ContentProgress; cappedFiles: string[] } {
  const buffered = previous && previous.offset < previous.batch.items.length;
  if (buffered) {
    const progress = finder.getScanProgress();
    if (!progress.ok) throw new Error(progress.error);
    if (progress.value.indexVersion !== previous.batch.indexVersion)
      throw new Error("Content index changed; restart the query without a cursor.");
  }
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
