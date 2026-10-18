import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GrepMode, SearchResult } from "@ff-labs/fff-node";
import { Type } from "typebox";
import type { ActionTool } from "../../deferred-action-tool.ts";
import { formatFindOutput, formatGrepOutput } from "./format.ts";
import { buildQuery, hasGlobSyntax } from "../native/query.ts";
import { contentPage, searchContent, multilineOrError, MATCHES_PER_FILE } from "../native/content.ts";
import { FIND_SNAPSHOT_LIMIT } from "../cursors.ts";
import { CollapsedText, renderTextResult } from "../ui/render.ts";
import { safeText } from "../../tool-names.ts";
import type { SearchLease, SearchRuntime } from "../session.ts";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
const FIND_PAGE_SIZE_MAX = 100;
const GREP_TIME_BUDGET_MS = 10_000;
const NATIVE_MULTILINE_NOTICE = "Native multiline results are LIMITED blocks, not individual-hit counts: adjacent hits may coalesce and blocks may be clipped at 512 bytes before reaching the SDK. outputTruncated=true conservatively marks potential incompleteness, not measured truncation. Refine the query or read matching files.";
const pathSchema = Type.Optional(Type.String({ description:
  "Include path: directory prefix (src/), filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Matches the whole root-relative path. Existing absolute files are literal, including glob metacharacters. Outside-workspace paths and existing directory paths containing spaces use a separate local index. Filename/glob filters containing whitespace are unsupported; search the containing directory instead.",
}));
const excludeSchema = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description:
  "Exclude directories, filenames, or globs, as a comma/space-separated string or array. Leading ! is optional. Example: 'test/,*.min.js,!vendor/'.",
}));
const contextSchema = Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Context lines before and after each match (0-20)." }));
const cursorSchema = Type.Optional(Type.String({ description:
  "Opaque cursor from this action in the same session/cwd. Repeat the original pattern(s); other original parameters may be omitted, but must not be changed.",
}));
const caseSchema = Type.Optional(Type.Boolean({ description: "Force case-sensitive matching with true; otherwise smart-case (lowercase is insensitive)." }));
const grepLimitSchema = Type.Optional(Type.Integer({ minimum: 1, description: "Max matches per page (default 20, capped at 50)." }));

export const findSchema = Type.Object({
  pattern: Type.String({ description: "Fuzzy path query, glob, or empty string for listing by path. Multi-word is narrower (AND), not bound to order. Prefer 1-2 concept terms; use path for exact filename globs." }),
  path: pathSchema,
  exclude: excludeSchema,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FIND_PAGE_SIZE_MAX, description: "Max results per page (default 30, capped at 100)." })),
  cursor: cursorSchema,
}, { additionalProperties: false });
export const grepSchema = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Search text or regex. Regex is auto-detected; invalid expressions fall back to literal matching. LF matches are limited native blocks (coalescing/512-byte clipping), not complete per-line coverage. Prefer concrete identifiers, not wildcard-only expressions." }),
  path: pathSchema,
  exclude: excludeSchema,
  caseSensitive: caseSchema,
  context: contextSchema,
  limit: grepLimitSchema,
  cursor: cursorSchema,
}, { additionalProperties: false });
export const multiGrepSchema = Type.Object({
  patterns: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Literal OR patterns. Multiple patterns must be LF-free. A single LF-containing literal is allowed as limited native blocks (coalescing/512-byte clipping); split LF-containing patterns into separate queries." }),
  constraints: Type.Optional(Type.String({ description: "Additional native file filters, e.g. '*.{ts,tsx} !test/'. Use path for external roots." })),
  path: pathSchema,
  exclude: excludeSchema,
  caseSensitive: caseSchema,
  context: contextSchema,
  limit: grepLimitSchema,
  cursor: cursorSchema,
}, { additionalProperties: false });

interface SearchDetails {
  totalMatched: number;
  totalFiles: number;
  root?: string;
  cursor?: string;
  pageIndex?: number;
  hasMore?: boolean;
  patterns?: string[];
  perFileLimitReached?: boolean;
  outputTruncated?: boolean;
  nativeMultilineLimited?: boolean;
}
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createSearchActions(runtime: SearchRuntime, toolName: string): ReadonlyMap<string, ActionTool> {
  const find: ToolDefinition<typeof findSchema, SearchDetails> = {
    name: toolName, label: "Find", annotations,
    description: `Fuzzy path and glob search, matching the whole root-relative path (not only filename). Native frecency-ranked, git-aware; multi-word is narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}. Stable snapshots allow at most ${FIND_SNAPSHOT_LIMIT} matches; narrow larger queries. For exact filenames use a glob in path; for directory listings use path='dir/**' and an empty pattern.`,
    parameters: findSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const scope = runtime.bind(ctx);
      const resumed = params.cursor ? runtime.cursors.get(params.cursor, "find", scope.id, params) : undefined;
      const request = resumed?.request ?? params;
      const lease = resumed ? runtime.resume(scope, resumed, signal)
        : await runtime.acquire(scope, params.path, signal);
      try {
        signal?.throwIfAborted();
        runtime.assertCurrent(scope);
        const notices = searchNotices(lease);
        const pageSize = Math.min(positiveLimit(request.limit, DEFAULT_FIND_LIMIT), FIND_PAGE_SIZE_MAX);
        const pattern = request.pattern!;
        const pageIndex = resumed?.nextPageIndex ?? 0;
        let snapshot = resumed?.snapshot;
        if (!snapshot) {
          const query = buildQuery(lease.constraint, pattern, request.exclude, lease.root);
          const searched = lease.finder.fileSearch(query, { pageIndex: 0, pageSize });
          if (!searched.ok) throw new Error(searched.error);
          snapshot = searched.value;
          if (snapshot.totalMatched > FIND_SNAPSHOT_LIMIT)
            throw new Error(`Find matched ${snapshot.totalMatched} files, exceeding the ${FIND_SNAPSHOT_LIMIT}-match snapshot budget. Narrow pattern/path; no partial pagination was created.`);
          if (snapshot.items.length < snapshot.totalMatched && !isWeakFind(snapshot, pattern)) {
            // Native offset queries can reorder ties. Even page one must come
            // from the same complete snapshot as every later page.
            const captured = lease.finder.fileSearch(query, { pageIndex: 0, pageSize: snapshot.totalMatched });
            if (!captured.ok) throw new Error(captured.error);
            if (captured.value.totalMatched !== snapshot.totalMatched || captured.value.items.length !== snapshot.totalMatched)
              throw new Error("Find index changed during snapshot creation. Retry or narrow the query; no partial pagination was created.");
            snapshot = captured.value;
          }
        }
        const start = pageIndex * pageSize;
        const items = snapshot.items.slice(start, start + pageSize);
        const weak = isWeakFind(snapshot, pattern);
        const formatted = formatFindOutput(items, pageSize, weak);
        const shownSoFar = start + items.length;
        const hasMore = !weak && items.length >= pageSize && snapshot.totalMatched > shownSoFar;
        let cursor: string | undefined;
        if (weak && formatted.shownCount) notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${snapshot.totalMatched}.`,
        );
        if (hasMore) {
          cursor = runtime.cursors.store({ action: "find", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, snapshot, nextPageIndex: pageIndex + 1,
          });
          const remaining = snapshot.totalMatched - shownSoFar;
          notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursor}" to continue`);
        }
        return textResult(withNotices(formatted.output, notices), {
          totalMatched: snapshot.totalMatched, totalFiles: snapshot.totalFiles, root: lease.root, pageIndex, hasMore, cursor,
        });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Find")) + " " + theme.fg("accent", safeText(args.pattern ?? "")) + theme.fg("toolOutput", safeText(` in ${args.path ?? "."}`));
      if (args.limit !== undefined) text += theme.fg("toolOutput", safeText(` (limit ${args.limit})`));
      if (args.cursor) text += theme.fg("muted", " (page)");
      return new CollapsedText(text, "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };

  const grep: ToolDefinition<typeof grepSchema, SearchDetails> = {
    name: toolName, label: "Search", annotations,
    description: "Search file contents. Smart-case, auto-detects regex vs literal, git-aware. Native frecency order across files, source order within files. Default limit 20. LF matches are limited native blocks (coalescing/512-byte clipping), flagged nativeMultilineLimited/outputTruncated for potential incompleteness. Use path/include and exclude to reduce noise; read the top matching file after 1-2 searches. Plain no-match queries may suggest fuzzy matches.",
    parameters: grepSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const scope = runtime.bind(ctx);
      const resumed = params.cursor ? runtime.cursors.get(params.cursor, "grep", scope.id, params) : undefined;
      const request = resumed?.request ?? params;
      const pattern = request.pattern!;
      let mode = resumed?.mode ?? detectMode(pattern);
      if (!pattern.trim() || mode === "regex" && wildcardOnly(pattern)) return textResult(
        `Pattern '${pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
        { totalMatched: 0, totalFiles: 0 },
      );
      const lease = resumed ? runtime.resume(scope, resumed, signal)
        : await runtime.acquire(scope, params.path, signal);
      try {
        signal?.throwIfAborted();
        runtime.assertCurrent(scope);
        const notices = searchNotices(lease);
        const pageSize = Math.min(positiveLimit(request.limit, DEFAULT_GREP_LIMIT), GREP_PAGE_SIZE_MAX);
        const context = mode === "fuzzy" ? 0 : clampContext(request.context);
        const query = resumed?.query ?? buildQuery(lease.constraint, "", request.exclude, lease.root);
        const options = { mode, smartCase: request.caseSensitive !== true, maxMatchesPerFile: MATCHES_PER_FILE,
          pageSize, beforeContext: context, afterContext: context, timeBudgetMs: GREP_TIME_BUDGET_MS };
        let page = contentPage(cursor => searchContent(lease.finder, pattern, query, { ...options, cursor }),
          pageSize, resumed?.progress);
        // Fuzzy suggestions are optional; only unambiguous identifier tokens
        // can cross the native fuzzy API's combined pattern/filter grammar.
        if (!page.result.items.length && !page.progress && !resumed && mode === "plain" && /^[\p{L}\p{N}_-]+$/u.test(pattern)) {
          const fuzzy = searchContent(lease.finder, pattern, query, { ...options,
            mode: "fuzzy", cursor: null, beforeContext: 0, afterContext: 0 });
          if (fuzzy.ok && fuzzy.value.items.length) {
            page = contentPage(() => fuzzy, pageSize);
            mode = "fuzzy";
          }
        }
        const formatted = contentPageResult(page, notices);
        let cursor: string | undefined;
        if (page.progress) {
          cursor = runtime.cursors.store({ action: "grep", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, query, progress: page.progress, mode,
          });
          notices.push(`Continue with cursor="${cursor}"`);
        }
        let output = withNotices(formatted.output, notices);
        if (mode === "fuzzy") output = `[0 exact matches. Maybe you meant this?]\n${output}`;
        return textResult(output, { ...formatted.details, root: lease.root, cursor });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Search")) + " " + theme.fg("accent", safeText(`/${args.pattern ?? ""}/`)) + theme.fg("toolOutput", safeText(` in ${args.path ?? "."}`));
      const options: string[] = [];
      if (args.limit !== undefined) options.push(`limit ${args.limit}`);
      if (args.context !== undefined) options.push(`context ${args.context}`);
      if (options.length) text += theme.fg("toolOutput", safeText(` (${options.join(", ")})`));
      if (args.cursor) text += theme.fg("muted", " (page)");
      return new CollapsedText(text, "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };

  const multi: ToolDefinition<typeof multiGrepSchema, SearchDetails> = {
    name: toolName, label: "Search", annotations,
    description: "Search file contents for ANY of multiple LF-free literals (native SIMD OR). A single LF-containing literal is allowed as limited native blocks (coalescing/512-byte clipping), flagged nativeMultilineLimited/outputTruncated for potential incompleteness; split LF-containing patterns into separate queries. Supports native constraints plus path/exclude, smart-case, context, and cursor pagination. Default limit 20.",
    parameters: multiGrepSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!params.patterns.length || params.patterns.some(pattern => !pattern.trim())) throw new Error("patterns must contain non-empty literal patterns.");
      const unsupported = multilineOrError(params.patterns);
      if (unsupported) throw new Error(unsupported);
      const scope = runtime.bind(ctx);
      const resumed = params.cursor ? runtime.cursors.get(params.cursor, "multi_grep", scope.id, params) : undefined;
      const request = resumed?.request ?? params;
      const lease = resumed ? runtime.resume(scope, resumed, signal)
        : await runtime.acquire(scope, params.path, signal);
      try {
        signal?.throwIfAborted();
        runtime.assertCurrent(scope);
        const notices = searchNotices(lease);
        const pageSize = Math.min(positiveLimit(request.limit, DEFAULT_GREP_LIMIT), GREP_PAGE_SIZE_MAX);
        const context = clampContext(request.context);
        const query = resumed?.query ?? [buildQuery(lease.constraint, "", request.exclude, lease.root), request.constraints].filter(Boolean).join(" ");
        const page = contentPage(cursor => searchContent(lease.finder, request.patterns!, query, {
          maxMatchesPerFile: MATCHES_PER_FILE, pageSize, smartCase: request.caseSensitive !== true, cursor,
          beforeContext: context, afterContext: context, timeBudgetMs: GREP_TIME_BUDGET_MS,
        }), pageSize, resumed?.progress);
        const formatted = contentPageResult(page, notices);
        let cursor: string | undefined;
        if (page.progress) {
          cursor = runtime.cursors.store({ action: "multi_grep", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, query, progress: page.progress,
          });
          notices.push(`More available. cursor="${cursor}" to continue`);
        }
        return textResult(withNotices(formatted.output, notices), {
          ...formatted.details, root: lease.root, cursor, patterns: request.patterns,
        });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Search")) + " " + theme.fg("accent", (args.patterns ?? []).map(pattern => safeText(JSON.stringify(pattern))).join(", "));
      if (args.path) text += theme.fg("toolOutput", safeText(` in ${args.path}`));
      if (args.constraints) text += theme.fg("toolOutput", safeText(` (${args.constraints})`));
      if (args.cursor) text += theme.fg("muted", " (page)");
      return new CollapsedText(text, "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };
  return new Map<string, ActionTool>([["find", find], ["grep", grep], ["multi_grep", multi]]);
}

function searchNotices(lease: SearchLease): string[] {
  const notices = lease.auxiliary ? [`Search root: ${lease.root}`] : [];
  const progress = lease.finder.getScanProgress();
  if (progress.ok && progress.value.isScanning)
    notices.push("Index scan is still running; results cover only currently indexed files. Retry after the scan finishes.");
  return notices;
}

/** Both content actions expose the same collection limits and display status. */
function contentPageResult(page: ReturnType<typeof contentPage>, notices: string[]) {
  const { result, cappedFiles } = page;
  const nativeMultilineLimited = result.nativeMultilineLimited === true;
  if (nativeMultilineLimited) notices.push(NATIVE_MULTILINE_NOTICE);
  if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
  if (cappedFiles.length) notices.push(`Native per-file match limit (${MATCHES_PER_FILE}) reached in ${cappedFiles.join(", ")}; additional matches may be omitted. Refine the query or read those files.`);
  const formatted = formatGrepOutput(result);
  return { output: formatted.output, details: {
    totalMatched: result.totalMatched, totalFiles: result.totalFiles, hasMore: !!page.progress,
    perFileLimitReached: cappedFiles.length > 0, outputTruncated: formatted.truncated || nativeMultilineLimited, nativeMultilineLimited,
  } };
}

function textResult(text: string, details: SearchDetails) {
  return { content: [{ type: "text" as const, text }], details };
}
function withNotices(output: string, notices: string[]): string { return notices.length ? `${output}\n\n[${notices.join(". ")}]` : output; }
function positiveLimit(limit: number | undefined, fallback: number): number { return Number.isFinite(limit) ? Math.max(1, Math.floor(limit!)) : fallback; }
function clampContext(context: number | undefined): number { return Math.min(20, Math.max(0, Math.floor(context ?? 0))); }
function detectMode(pattern: string): GrepMode {
  if (!/[.*+?^${}()|[\]\\]/.test(pattern)) return "plain";
  try { new RegExp(pattern); return "regex"; } catch { return "plain"; }
}
function wildcardOnly(pattern: string): boolean {
  return /^(?:[.^$]*(?:\.[*+?]|[*+])[.^$]*|[.^$\s]*|\.[*+]\?|\?)$/.test(pattern.trim());
}
function isWeakFind(result: SearchResult, pattern: string): boolean {
  const fuzzy = pattern.trim().split(/\s+/).some(token => token && !hasGlobSyntax(token) && !token.startsWith("!"));
  return result.items.length > 0 && fuzzy && (result.scores[0]?.total ?? 0) < Math.floor(pattern.length * 6);
}
