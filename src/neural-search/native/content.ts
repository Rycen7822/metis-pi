import type { FileFinderApi, GrepCursor, GrepOptions, GrepResult, Result } from "./binding/api.ts";

export const MATCHES_PER_FILE = 200;
export interface ContentResult extends GrepResult { nativeMultilineLimited?: boolean; }
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
    ? finder.grep([constraints, pattern].filter(Boolean).join(" "), { ...shared, mode })
    : searchRegex(finder, pattern, constraints, shared);
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
  const found = searchRegex(finder, expression, constraints, options);
  return found.ok && found.value.regexFallbackError
    ? { ok: false, error: `Cannot encode multiline literal search: ${found.value.regexFallbackError}` } : found;
}

function searchRegex(finder: FileFinderApi, pattern: string, constraints: string, options: GrepOptions): Result<ContentResult> {
  // Leading regex escape bypasses FFF constraint parsing; optional word boundary
  // is zero-width and always succeeds. Keep the expression in one native token.
  // Native build_regex blindly decodes \\n again, even inside \\\\n.
  // Hex-encode literal backslash atoms before transporting the expression.
  const encoded = pattern.replace(/\\\\/g, "\\x5c").replace(/(\\*)\p{White_Space}/gu, (token, escapes: string) => {
    const char = token.at(-1)!;
    const prefix = escapes.slice(0, escapes.length - escapes.length % 2);
    return prefix + (char === "\n" ? "\\n" : `\\x{${char.codePointAt(0)!.toString(16)}}`);
  });
  const found = finder.grep([constraints, `\\b?(?:${encoded})`].filter(Boolean).join(" "), { ...options, mode: "regex" });
  return found.ok && encoded.includes("\\n") && found.value.items.length
    ? { ok: true, value: { ...found.value, nativeMultilineLimited: true } } : found;
}

export function contentPage(
  search: (cursor: GrepCursor | null) => Result<ContentResult>, limit: number, previous?: ContentProgress,
): { result: ContentResult; progress?: ContentProgress; cappedFiles: string[] } {
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
