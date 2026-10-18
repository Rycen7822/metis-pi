import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GrepMode } from "@ff-labs/fff-node";
import { Type } from "typebox";
import type { ActionTool } from "../../deferred-action-tool.ts";
import { formatFindOutput, formatGrepOutput } from "./format.ts";
import { buildQuery } from "../native/query.ts";
import { CollapsedText, renderTextResult } from "../ui/render.ts";
import type { SearchLease, SearchRuntime } from "../session.ts";

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
const GREP_MAX_MATCHES_PER_FILE = 200;
const GREP_TIME_BUDGET_MS = 10_000;
const pathSchema = Type.Optional(Type.String({ description:
  "Include path: directory prefix (src/), filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Matches the whole root-relative path. Outside-workspace paths and existing directory paths containing spaces use a separate local index. Filename/glob filters containing whitespace are unsupported; search the containing directory instead.",
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
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Max results per page (default 30)." })),
  cursor: cursorSchema,
}, { additionalProperties: false });
export const grepSchema = Type.Object({
  pattern: Type.String({ minLength: 1, description: "Search text or regex. Regex is auto-detected; invalid expressions fall back to literal matching. Prefer concrete identifiers, not wildcard-only expressions." }),
  path: pathSchema,
  exclude: excludeSchema,
  caseSensitive: caseSchema,
  context: contextSchema,
  limit: grepLimitSchema,
  cursor: cursorSchema,
}, { additionalProperties: false });
export const multiGrepSchema = Type.Object({
  patterns: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Literal patterns, matched with OR logic. Include snake_case/camelCase/PascalCase variants as needed." }),
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
}
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function createSearchActions(runtime: SearchRuntime, toolName: string): ReadonlyMap<string, ActionTool> {
  const find: ToolDefinition<typeof findSchema, SearchDetails> = {
    name: toolName, label: "Find", annotations,
    description: `Fuzzy path and glob search, matching the whole root-relative path (not only filename). Native frecency-ranked, git-aware; multi-word is narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}. For exact filenames use a glob in path; for directory listings use path='dir/**' and an empty pattern.`,
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
        const pageSize = positiveLimit(request.limit, DEFAULT_FIND_LIMIT);
        const pattern = request.pattern!;
        const pageIndex = resumed?.nextPageIndex ?? 0;
        // FFF 0.11 uses an item offset despite naming this option pageIndex.
        const query = resumed?.query ?? buildQuery(lease.constraint, pattern, request.exclude, lease.root);
        const searched = lease.finder.fileSearch(query, { pageIndex: pageIndex * pageSize, pageSize });
        if (!searched.ok) throw new Error(searched.error);
        const result = searched.value;
        const formatted = formatFindOutput(result, pageSize, pattern);
        const shownSoFar = pageIndex * pageSize + result.items.length;
        const hasMore = result.items.length >= pageSize && result.totalMatched > shownSoFar;
        let cursor: string | undefined;
        if (formatted.weak && formatted.shownCount) notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );
        if (!formatted.weak && hasMore) {
          cursor = runtime.cursors.store({ action: "find", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, query, nextPageIndex: pageIndex + 1,
          });
          const remaining = result.totalMatched - shownSoFar;
          notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursor}" to continue`);
        }
        return textResult(withNotices(formatted.output, notices), {
          totalMatched: result.totalMatched, totalFiles: result.totalFiles, root: lease.root, pageIndex, hasMore, cursor,
        });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Find")) + " " + theme.fg("accent", args.pattern ?? "") + theme.fg("toolOutput", ` in ${args.path ?? "."}`);
      if (args.limit !== undefined) text += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args.cursor) text += theme.fg("muted", " (page)");
      return new CollapsedText(text, "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };

  const grep: ToolDefinition<typeof grepSchema, SearchDetails> = {
    name: toolName, label: "Search", annotations,
    description: "Search file contents. Smart-case, auto-detects regex vs literal, git-aware. Native frecency order across files, source order within files. Default limit 20. Use path/include and exclude to reduce noise; read the top matching file after 1-2 searches. Plain no-match queries may suggest fuzzy matches.",
    parameters: grepSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const scope = runtime.bind(ctx);
      const resumed = params.cursor ? runtime.cursors.get(params.cursor, "grep", scope.id, params) : undefined;
      const request = resumed?.request ?? params;
      const pattern = request.pattern!;
      const detected = detectMode(pattern);
      if (wildcardOnly(pattern)) return textResult(
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
        let mode = resumed?.mode ?? detected;
        const context = mode === "fuzzy" ? 0 : clampContext(request.context);
        const smartCase = request.caseSensitive !== true;
        let query = resumed?.query ?? buildQuery(lease.constraint, pattern, request.exclude, lease.root);
        const options = { mode, smartCase, maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE, pageSize,
          cursor: resumed?.native ?? null, beforeContext: context, afterContext: context,
          timeBudgetMs: GREP_TIME_BUDGET_MS,
        };
        const searched = lease.finder.grep(query, options);
        if (!searched.ok) throw new Error(searched.error);
        let result = searched.value;
        if (!result.items.length && !result.nextCursor && !resumed && mode !== "regex") {
          const lastSegment = request.path?.split(/[\\/]/).pop() ?? "";
          // A misnamed file can broaden, but never discard caller exclusions.
          const fuzzyQuery = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)
            ? buildQuery(undefined, pattern, request.exclude, lease.root) : query;
          const fuzzy = lease.finder.grep(fuzzyQuery, { ...options, mode: "fuzzy", cursor: null, beforeContext: 0, afterContext: 0 });
          if (fuzzy.ok && fuzzy.value.items.length) {
            result = fuzzy.value;
            query = fuzzyQuery;
            mode = "fuzzy";
          }
        }
        if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
        let cursor: string | undefined;
        if (result.nextCursor) {
          cursor = runtime.cursors.store({ action: "grep", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, query, native: result.nextCursor, mode,
          });
          notices.push(`Continue with cursor="${cursor}"`);
        }
        let output = withNotices(formatGrepOutput(result), notices);
        if (mode === "fuzzy") output = `[0 exact matches. Maybe you meant this?]\n${output}`;
        return textResult(output, { totalMatched: result.totalMatched, totalFiles: result.totalFiles, root: lease.root, cursor });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Search")) + " " + theme.fg("accent", `/${args.pattern ?? ""}/`) + theme.fg("toolOutput", ` in ${args.path ?? "."}`);
      const options: string[] = [];
      if (args.limit !== undefined) options.push(`limit ${args.limit}`);
      if (args.context !== undefined) options.push(`context ${args.context}`);
      if (options.length) text += theme.fg("toolOutput", ` (${options.join(", ")})`);
      if (args.cursor) text += theme.fg("muted", " (page)");
      return new CollapsedText(text, "", theme.fg("muted", "..."));
    },
    renderResult: renderTextResult,
  };

  const multi: ToolDefinition<typeof multiGrepSchema, SearchDetails> = {
    name: toolName, label: "Search", annotations,
    description: "Search file contents for ANY of multiple literal patterns (OR, native SIMD Aho-Corasick). Faster than regex alternation. Supports native constraints plus path/exclude, smart-case, context, and cursor pagination. Default limit 20.",
    parameters: multiGrepSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!params.patterns.length || params.patterns.some(pattern => !pattern.trim())) throw new Error("patterns must contain non-empty literal patterns.");
      const scope = runtime.bind(ctx);
      const resumed = params.cursor ? runtime.cursors.get(params.cursor, "multi_grep", scope.id, params) : undefined;
      const request = resumed?.request ?? params;
      const lease = resumed ? runtime.resume(scope, resumed, signal)
        : await runtime.acquire(scope, params.path, signal);
      try {
        signal?.throwIfAborted();
        runtime.assertCurrent(scope);
        const notices = searchNotices(lease);
        const effectiveLimit = positiveLimit(request.limit, DEFAULT_GREP_LIMIT);
        const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
        const context = clampContext(request.context);
        const smartCase = request.caseSensitive !== true;
        const query = resumed?.query ?? [buildQuery(lease.constraint, "", request.exclude, lease.root), request.constraints].filter(Boolean).join(" ");
        const searched = lease.finder.multiGrep({ patterns: request.patterns!, constraints: query || undefined,
          maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE, pageSize, smartCase, cursor: resumed?.native ?? null,
          beforeContext: context, afterContext: context, timeBudgetMs: GREP_TIME_BUDGET_MS,
        });
        if (!searched.ok) throw new Error(searched.error);
        const result = searched.value;
        if (result.items.length >= effectiveLimit) notices.push(`${effectiveLimit}+ matches (refine patterns)`);
        let cursor: string | undefined;
        if (result.nextCursor) {
          cursor = runtime.cursors.store({ action: "multi_grep", scope: scope.id, root: lease.root, auxiliary: lease.auxiliary,
            finder: lease.finder, request, query, native: result.nextCursor,
          });
          notices.push(`More available. cursor="${cursor}" to continue`);
        }
        return textResult(withNotices(formatGrepOutput(result), notices), {
          totalMatched: result.totalMatched, totalFiles: result.totalFiles, root: lease.root, cursor, patterns: request.patterns,
        });
      } finally { lease.release(); }
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Search")) + " " + theme.fg("accent", (args.patterns ?? []).map(pattern => `"${pattern}"`).join(", "));
      if (args.path) text += theme.fg("toolOutput", ` in ${args.path}`);
      if (args.constraints) text += theme.fg("toolOutput", ` (${args.constraints})`);
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
  return !pattern.trim() || /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(pattern.trim());
}
