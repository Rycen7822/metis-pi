// Text/Markdown provenance adapters. Both wrap prototype.render: the host
// render runs untouched. It publishes a derivation bound to the returned rows;
// extraction builds the mirror only when needed. The mirror uses the host's
// textual methods on frame inputs, then verifies row-by-row visible output.
// A mismatch falls back to the displayed rows instead of copying stale text.

import {
  decorationRow,
  deferCopyProduct,
  publishRows,
  registerProduct,
  registerCacheReleaser,
  type BreakBefore,
  type CopyProduct,
  type CopyRow,
  type CopySource,
} from "./model.ts";
import { stripAnsi, wrapWithProvenance } from "./wrap.ts";
import type { AdapterHostFns } from "./serialize.ts";
import type { CopyLexer, MarkdownToken } from "./parser.ts";
import { stripHtmlComments } from "./parser.ts";

export interface MarkdownInstance {
  text: string;
  paddingX: number;
  paddingY: number;
  theme?: Record<string, unknown>;
  options?: Record<string, unknown>;
  defaultTextStyle?: Record<string, unknown>;
  renderInlineTokens?: (tokens: MarkdownToken[], styleContext: unknown) => string;
  renderToken?: (token: MarkdownToken, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
  [key: string]: unknown;
}

export interface TextInstance {
  text: string;
  paddingX: number;
  paddingY: number;
  [key: string]: unknown;
}

export interface MarkdownDiagnostics {
  markdownBuilt: number;
  markdownDegraded: number;
  textBuilt: number;
  textDegraded: number;
  lastDegradedReason: string;
}

interface PrefixSpec {
  cells: number;
  kind: "content" | "decoration" | "semantic";
  text: string;
  styled: string;
}

interface LogicalLine {
  segments: { styled: string; kind: "content" | "decoration" | "semantic" }[];
  /** Inner wrap (list item / quote content) with per-row prefixes. */
  inner?: {
    width: number;
    firstPrefix: PrefixSpec;
    continuationPrefix: PrefixSpec;
    /** True when row 0 of THIS line takes the first prefix (item start). */
    firstOnRowZero: boolean;
  };
  /** Host-rendered rows for token types without a provenance mirror. */
  unknownStyledRows?: string[];
}

interface MirrorContext {
  instance: MarkdownInstance | TextInstance;
  fns: AdapterHostFns;
  codeRows?: WeakMap<object, readonly string[]>;
}

// Observe token output, not the live theme/highlighter. Neither tokens nor old
// full render arrays gain a strong owner, including during reentrant renders.
interface CodeCapture { rows?: WeakMap<object, readonly string[]> }
const activeCodeRows = new WeakMap<object, CodeCapture>();
const codeRowsFor = new WeakMap<object, WeakMap<object, readonly string[]>>();

function painter(instance: MarkdownInstance, name: string): (text: string) => string {
  const theme = instance.theme as Record<string, (text: string) => string> | undefined;
  const fn = theme?.[name];
  if (typeof fn !== "function") return (text) => text;
  return fn.bind(theme);
}

function defaultStyleContext(instance: MarkdownInstance): unknown {
  const fn = (instance as unknown as { getDefaultInlineStyleContext?: () => unknown }).getDefaultInlineStyleContext;
  return typeof fn === "function" ? fn.call(instance) : undefined;
}

function sentinelPrefix(styleFn: (text: string) => string): string {
  const styled = styleFn("\u0000");
  const index = styled.indexOf("\u0000");
  return index >= 0 ? styled.slice(0, index) : "";
}

function renderInline(instance: MarkdownInstance, tokens: MarkdownToken[], styleContext: unknown): string {
  const fn = instance.renderInlineTokens;
  if (typeof fn === "function") return fn.call(instance, tokens, styleContext);
  return tokens.map((token) => token.text ?? "").join("");
}

function applyDefaultStyle(instance: MarkdownInstance, text: string): string {
  const style = instance.defaultTextStyle;
  if (!style) return text;
  let styled = text;
  if (typeof style.color === "function") styled = (style.color as (t: string) => string)(styled);
  if (style.bold === true) styled = painter(instance, "bold")(styled);
  if (style.italic === true) styled = painter(instance, "italic")(styled);
  if (style.strikethrough === true) styled = painter(instance, "strikethrough")(styled);
  if (style.underline === true) styled = painter(instance, "underline")(styled);
  return styled;
}

let latexPainter: ((text: string, options?: { display?: boolean }) => string | null) | undefined;

export function setLatexPainter(fn: (text: string, options?: { display?: boolean }) => string | null): void {
  latexPainter = fn;
}

/** Mirror of Markdown.renderToken. Token types without a provenance mirror
 * fall back to the instance's own renderToken (exact rows, unknown spans). */
function renderTokenMirror(
  ctx: MirrorContext,
  token: MarkdownToken,
  width: number,
  nextTokenType: string | undefined,
  styleContext: unknown,
): LogicalLine[] {
  const instance = ctx.instance as MarkdownInstance;
  const contentLine = (styled: string, kind: "content" | "decoration" | "semantic" = "content"): LogicalLine => ({
    segments: [{ styled, kind }],
  });
  const spacing = (nextType: string | undefined, except: string[]): LogicalLine[] =>
    nextType && !except.includes(nextType) ? [{ segments: [] }] : [];
  switch (token.type) {
    case "heading": {
      const depth = token.depth ?? 1;
      const headingPrefix = depth >= 3 ? `${"#".repeat(depth)} ` : "";
      const heading = painter(instance, "heading");
      const bold = painter(instance, "bold");
      const underline = painter(instance, "underline");
      const headingStyleFn = depth === 1
        ? (text: string) => heading(bold(underline(text)))
        : (text: string) => heading(bold(text));
      const headingStyleContext = { applyText: headingStyleFn, stylePrefix: sentinelPrefix(headingStyleFn) };
      const headingText = renderInline(instance, token.tokens ?? [], headingStyleContext);
      const segments: { styled: string; kind: "content" | "decoration" | "semantic" }[] = [];
      if (headingPrefix) segments.push({ styled: headingStyleFn(headingPrefix), kind: "semantic" });
      segments.push({ styled: headingText, kind: "content" });
      const lines: LogicalLine[] = [{ segments }];
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "paragraph": {
      const lines: LogicalLine[] = [contentLine(renderInline(instance, token.tokens ?? [], styleContext))];
      lines.push(...spacing(nextTokenType, ["list", "space"]));
      return lines;
    }
    case "text": {
      return [contentLine(renderInline(instance, [token], styleContext))];
    }
    case "latexBlock": {
      let rendered = token.pending !== true && instance.options?.renderLatex !== false
        ? latexPainter?.(token.text ?? "", { display: true })
        : undefined;
      if (rendered == null || rendered.split("\n").some(line => ctx.fns.visibleWidth(line) > width))
        rendered = (token.raw ?? "").trim();
      const lines = rendered.split("\n").map((line) => contentLine(applyDefaultStyle(instance, line)));
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "code": {
      const indent = (instance.theme as { codeBlockIndent?: string } | undefined)?.codeBlockIndent ?? "  ";
      const fence = painter(instance, "codeBlockBorder");
      const codeBlock = painter(instance, "codeBlock");
      const codeLines = (token.text ?? "").split("\n");
      const captured = ctx.codeRows?.get(token);
      const bodyRows = captured?.slice(1, codeLines.length + 1);
      const spacingCount = nextTokenType && nextTokenType !== "space" ? 1 : 0;
      if (captured && (captured.length !== codeLines.length + 2 + spacingCount
          || bodyRows?.some(line => !line.startsWith(indent))))
        return hostRenderedLines(ctx, token, width, nextTokenType, styleContext);
      const highlight = (instance.theme as { highlightCode?: (text: string, lang: string) => string[] } | undefined)?.highlightCode;
      const highlighted = bodyRows ? bodyRows.map(line => line.slice(indent.length))
        : highlight ? highlight(token.text ?? "", token.lang ?? "") : undefined;
      const lines: LogicalLine[] = [contentLine(captured?.[0] ?? fence("```" + (token.lang || "")), "semantic")];
      if (highlighted && highlighted.length !== codeLines.length) {
        // Highlighter changed the line count: exact rows, unknown spans.
        return hostRenderedLines(ctx, token, width, nextTokenType, styleContext);
      }
      for (let i = 0; i < codeLines.length; i++) {
        lines.push({
          segments: [
            { styled: indent, kind: "decoration" },
            { styled: highlighted ? highlighted[i]! : codeBlock(codeLines[i]!), kind: "content" },
          ],
        });
      }
      lines.push(contentLine(captured?.[codeLines.length + 1] ?? fence("```"), "semantic"));
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "list": {
      return renderListMirror(ctx, token, 0, width, styleContext);
    }
    case "blockquote": {
      const lines = renderQuoteMirror(ctx, token, width, styleContext);
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "hr": {
      const rule = "─".repeat(Math.min(width, 80));
      const lines: LogicalLine[] = [contentLine(painter(instance, "hr")(rule), "semantic")];
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "html": {
      // Native hides HTML comments and comment-only blocks are filtered from the
      // token stream; mirror the visible text so the row check still matches.
      if (typeof token.raw === "string") {
        return [contentLine(applyDefaultStyle(instance, stripHtmlComments(token.raw).trim()))];
      }
      return [];
    }
    case "space": {
      return [{ segments: [] }];
    }
    default: {
      if (typeof token.text === "string") {
        return [contentLine(token.text)];
      }
      return hostRenderedLines(ctx, token, width, nextTokenType, styleContext);
    }
  }
}

/** Exact host rows for tokens without a provenance mirror: rendered by the
 * instance's own renderToken and wrapped by the host wrap. Registered as
 * unknown rows (native extraction) but positionally exact. */
function hostRenderedLines(
  ctx: MirrorContext,
  token: MarkdownToken,
  width: number,
  nextTokenType: string | undefined,
  styleContext: unknown,
): LogicalLine[] {
  const renderToken = ctx.instance.renderToken;
  if (typeof renderToken !== "function") {
    throw new Error("instance renderToken unavailable");
  }
  const rendered = renderToken.call(ctx.instance, token, width, nextTokenType, styleContext);
  return [{ segments: [], unknownStyledRows: rendered }];
}

function renderListMirror(
  ctx: MirrorContext,
  token: MarkdownToken,
  depth: number,
  width: number,
  styleContext: unknown,
): LogicalLine[] {
  const lines: LogicalLine[] = [];
  const instance = ctx.instance as MarkdownInstance;
  const fns = ctx.fns;
  const indent = "    ".repeat(depth);
  const startNumber = typeof token.start === "number" ? token.start : 1;
  const items = token.items ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const isLastItem = i === items.length - 1;
    const bullet = token.ordered === true
      ? instance.options?.preserveOrderedListMarkers === true
        ? (orderedMarker(item) ?? `${startNumber + i}. `)
        : `${startNumber + i}. `
      : instance.options?.preserveOrderedListMarkers === true
        ? (unorderedMarker(item) ?? "- ")
        : "- ";
    const taskMarker = item.task === true ? `[${item.checked ? "x" : " "}] ` : "";
    const marker = bullet + taskMarker;
    const firstPrefixStyled = indent + painter(instance, "listBullet")(marker);
    const continuationStyled = indent + " ".repeat(fns.visibleWidth(marker));
    const firstPrefix: PrefixSpec = {
      cells: fns.visibleWidth(ctx.fns.stripAnsi(firstPrefixStyled)),
      kind: "semantic",
      text: ctx.fns.stripAnsi(firstPrefixStyled),
      styled: firstPrefixStyled,
    };
    const continuationPrefix: PrefixSpec = {
      cells: fns.visibleWidth(ctx.fns.stripAnsi(continuationStyled)),
      kind: "decoration",
      text: "",
      styled: continuationStyled,
    };
    const itemWidth = Math.max(1, width - firstPrefix.cells);
    let renderedAnyLine = false;
    let firstLineOfItem = true;
    for (const itemToken of item.tokens ?? []) {
      if (itemToken.type === "list") {
        lines.push(...renderListMirror(ctx, itemToken, depth + 1, width, styleContext));
        renderedAnyLine = true;
        continue;
      }
      for (const line of renderTokenMirror(ctx, itemToken, itemWidth, undefined, styleContext)) {
        renderedAnyLine = true;
        const inner = line.inner ?? {
          width: itemWidth,
          firstPrefix,
          continuationPrefix,
          firstOnRowZero: firstLineOfItem,
        };
        firstLineOfItem = false;
        lines.push({ ...line, inner });
      }
    }
    if (!renderedAnyLine) {
      // Empty item: host pushes the first prefix alone.
      lines.push({
        segments: [],
        inner: { width: itemWidth, firstPrefix, continuationPrefix, firstOnRowZero: true },
      });
    }
    if (token.loose === true && !isLastItem) {
      lines.push({ segments: [] });
    }
  }
  return lines;
}

function orderedMarker(item: MarkdownToken): string | undefined {
  const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw ?? "");
  return match ? `${match[1]!} ` : undefined;
}

function unorderedMarker(item: MarkdownToken): string | undefined {
  const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw ?? "");
  return match ? `${match[1]!} ` : undefined;
}

function renderQuoteMirror(ctx: MirrorContext, token: MarkdownToken, width: number, styleContext: unknown): LogicalLine[] {
  const quoteTokens = token.tokens ?? [];
  // A border needs two cells plus content. Native Pi omits it at narrower widths instead of rewrapping exponentially.
  if (width < 3) return quoteTokens.flatMap((child, index) =>
    renderTokenMirror(ctx, child, width, quoteTokens[index + 1]?.type, styleContext));
  const instance = ctx.instance as MarkdownInstance;
  const fns = ctx.fns;
  const quote = painter(instance, "quote");
  const italic = painter(instance, "italic");
  const quoteStyle = (text: string) => quote(italic(text));
  const quoteStylePrefix = sentinelPrefix(quoteStyle);
  const applyQuoteStyle = (line: string): string => {
    if (!quoteStylePrefix) return quoteStyle(line);
    return quoteStyle(line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`));
  };
  const quoteContentWidth = width - 2;
  const quoteInlineStyleContext = { applyText: (text: string) => text, stylePrefix: quoteStylePrefix };
  const rendered: LogicalLine[] = [];
  for (let i = 0; i < quoteTokens.length; i++) {
    rendered.push(...renderTokenMirror(ctx, quoteTokens[i]!, quoteContentWidth, quoteTokens[i + 1]?.type, quoteInlineStyleContext));
  }
  while (rendered.length > 0 && rendered[rendered.length - 1]!.segments.length === 0
      && rendered[rendered.length - 1]!.unknownStyledRows === undefined) {
    rendered.pop();
  }
  const border = painter(instance, "quoteBorder")("│ ");
  const borderPrefix: PrefixSpec = {
    cells: fns.visibleWidth(ctx.fns.stripAnsi(border)),
    kind: "semantic",
    text: ctx.fns.stripAnsi(border),
    styled: border,
  };
  const continuationBorder: PrefixSpec = { ...borderPrefix, kind: "decoration", text: "" };
  return rendered.map((line) => {
    if (line.unknownStyledRows) return line;
    return {
      segments: line.segments.map((segment) => ({ ...segment, styled: applyQuoteStyle(segment.styled) })),
      inner: {
        width: quoteContentWidth,
        firstPrefix: borderPrefix,
        continuationPrefix: continuationBorder,
        firstOnRowZero: true,
      },
    };
  });
}

interface MirrorOutput {
  styledRows: string[];
  copyRows: CopyRow[];
}

function assembleRows(
  ctx: MirrorContext,
  logicalLines: LogicalLine[],
  contentWidth: number,
  hostWrap: (text: string, width: number) => string[],
): MirrorOutput {
  const styledRows: string[] = [];
  const copyRows: CopyRow[] = [];
  for (const line of logicalLines) {
    if (line.unknownStyledRows) {
      // Exact host rows, unknown spans; list/quote prefixes still apply so
      // the positional check stays honest.
      let rowIndex = 0;
      for (const rendered of line.unknownStyledRows) {
        for (const wrapped of hostWrap(rendered, line.inner ? line.inner.width : contentWidth)) {
          const prefix = line.inner
            ? (rowIndex === 0 && line.inner.firstOnRowZero ? line.inner.firstPrefix : line.inner.continuationPrefix)
            : undefined;
          const styled = prefix ? prefix.styled + wrapped : wrapped;
          styledRows.push(styled);
          copyRows.push({
            spans: [{ colStart: 0, colEnd: Math.max(1, contentWidth), kind: "unknown", text: "" }],
            breakBefore: "hard",
            bridge: undefined,
          });
          rowIndex += 1;
        }
      }
      continue;
    }
    const wrapWidth = line.inner ? line.inner.width : contentWidth;
    const rows = wrapWithProvenance(line.segments, wrapWidth, ctx.fns.visibleWidth);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const prefix = line.inner
        ? (rowIndex === 0 && line.inner.firstOnRowZero ? line.inner.firstPrefix : line.inner.continuationPrefix)
        : undefined;
      const styled = prefix ? prefix.styled + row.styled : row.styled;
      styledRows.push(styled);
      const spans = row.spans.map((span) => ({
        colStart: span.colStart + (prefix?.cells ?? 0),
        colEnd: span.colEnd + (prefix?.cells ?? 0),
        kind: span.kind,
        text: span.text,
      }));
      if (prefix && prefix.cells > 0) {
        spans.unshift({ colStart: 0, colEnd: prefix.cells, kind: prefix.kind, text: prefix.text });
      }
      const breakBefore: BreakBefore = rowIndex === 0 ? "hard" : row.hard ? "hard" : "soft";
      copyRows.push({ spans, breakBefore, bridge: breakBefore === "soft" ? row.bridge : undefined });
    }
  }
  return { styledRows, copyRows };
}

export interface WrapDeps {
  fns: AdapterHostFns;
  lexer: CopyLexer;
  hostWrap: (text: string, width: number) => string[];
  diagnostics: MarkdownDiagnostics;
}

interface MirrorFrame {
  lines: readonly string[];
  start: number;
  total: number;
  codeRows?: WeakRef<NonNullable<CodeCapture["rows"]>>;
}

/** Stable rows share one copy derivation, including a cached native-fallback decision. */
function wrapRenderPrototype<INST extends { text: string }>(
  prototype: object,
  key: symbol,
  deps: WrapDeps,
  snapshot: (instance: INST, width: number) => INST,
  build: (snapshot: INST, width: number, frame: MirrorFrame, deps: WrapDeps) => CopyProduct | undefined,
  counters: {
    built: "markdownBuilt" | "textBuilt";
    degraded: "markdownDegraded" | "textDegraded";
    fallback: string;
  },
  captureCode = false,
): boolean {
  if (Object.prototype.hasOwnProperty.call(prototype, key) || !Object.isExtensible(prototype)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as (this: INST, width: number) => string[];
  const cache = new WeakMap<object, { text: string; width: number; rows: readonly string[]; source: CopySource }>();
  function recordFailure(error: unknown) {
    deps.diagnostics[counters.degraded] += 1;
    deps.diagnostics.lastDegradedReason = error instanceof Error ? error.message : counters.fallback;
  }
  function sourceFor(input: INST, width: number, frame: MirrorFrame): CopySource {
    return deferCopyProduct(width, () => {
      try {
        const product = build(input, width, frame, deps);
        deps.diagnostics[product ? counters.built : counters.degraded] += 1;
        return product;
      } catch (error) {
        recordFailure(error);
        return undefined;
      }
    }, (start, end) => sourceFor(input, width, {
      ...frame, start: frame.start + start, lines: frame.lines.slice(start, end),
    }));
  }
  const wrapper = function (this: INST, width: number): string[] {
    const previousCapture = activeCodeRows.get(this);
    const captured: CodeCapture | undefined = captureCode ? {} : undefined;
    let rows: string[];
    try {
      if (captured) activeCodeRows.set(this, captured);
      rows = original.call(this, width);
    } finally {
      if (captured) {
        if (previousCapture) activeCodeRows.set(this, previousCapture);
        else activeCodeRows.delete(this);
      }
    }
    if (captured?.rows) codeRowsFor.set(rows, captured.rows);
    try {
      publishRows(this, rows);
      if (!rows.length) {
        cache.delete(this);
        registerProduct(rows, { width, rows: [] });
        return rows;
      }
      const cached = cache.get(this);
      if (cached?.rows === rows && cached.width === width) return rows;
      const input = snapshot(this, width);
      if (cached && cached.text === input.text && cached.width === width
          && cached.rows.length === rows.length && rows.every((row, i) => row === cached.rows[i])) {
        registerProduct(rows, cached.source);
        return rows;
      }
      const code = codeRowsFor.get(rows);
      const source = sourceFor(input, width, { lines: rows, start: 0, total: rows.length, codeRows: code && new WeakRef(code) });
      if (!cached) registerCacheReleaser(this, () => { cache.delete(this); });
      cache.set(this, { text: input.text, width, rows, source });
      registerProduct(rows, source);
    } catch (error) {
      recordFailure(error);
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  Object.defineProperty(prototype, key, { value: true, configurable: true });
  return true;
}

export const MARKDOWN_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-markdown");
export const TEXT_COPY_OWNER = Symbol.for("Rycen7822.metis-pi.copy-text");

export function wrapMarkdownPrototype(prototype: object, deps: WrapDeps): boolean {
  const tokenDescriptor = Object.getOwnPropertyDescriptor(prototype, "renderToken");
  const capture = tokenDescriptor && typeof tokenDescriptor.value === "function" && tokenDescriptor.configurable && tokenDescriptor.writable;
  const wrapped = wrapRenderPrototype<MarkdownInstance>(prototype, MARKDOWN_COPY_OWNER, deps,
    snapshotMarkdown, buildMarkdownProduct, { built: "markdownBuilt", degraded: "markdownDegraded", fallback: "mirror failed" }, !!capture);
  if (wrapped && capture) {
    const original = tokenDescriptor.value as NonNullable<MarkdownInstance["renderToken"]>;
    Object.defineProperty(prototype, "renderToken", { ...tokenDescriptor,
      value(this: MarkdownInstance, token: MarkdownToken, width: number, next?: string, style?: unknown) {
        const rows = original.call(this, token, width, next, style);
        const captured = activeCodeRows.get(this);
        if (captured && token.type === "code" && Array.isArray(rows) && rows.every(row => typeof row === "string")) {
          (captured.rows ??= new WeakMap()).set(token, rows.slice());
        }
        return rows;
      },
    });
  }
  return wrapped;
}

function buildMarkdownProduct(
  instance: MarkdownInstance,
  width: number,
  frame: MirrorFrame,
  deps: WrapDeps,
): CopyProduct | undefined {
  const contentWidth = Math.max(1, width - instance.paddingX * 2);
  if (!instance.text.trim()) return undefined;
  const normalized = instance.text.replace(/\t/g, "   ");
  const ctx: MirrorContext = { instance, fns: deps.fns, codeRows: frame.codeRows?.deref() };
  const native = instance.cachedTokens instanceof WeakRef
    ? instance.cachedTokens.deref() as { source?: unknown; tokens?: MarkdownToken[] } | undefined : undefined;
  const tokens = native?.source === normalized && Array.isArray(native.tokens) ? native.tokens : deps.lexer.lexer(normalized);
  const logicalLines: LogicalLine[] = [];
  const styleContext = defaultStyleContext(instance);
  for (let i = 0; i < tokens.length; i++) {
    logicalLines.push(...renderTokenMirror(ctx, tokens[i]!, contentWidth, tokens[i + 1]?.type, styleContext));
  }
  const output = assembleRows(ctx, logicalLines, contentWidth, deps.hostWrap);
  return verifyRows(frame, output, { width, contentWidth, padX: instance.paddingX, padY: instance.paddingY }, deps);
}

function snapshotMarkdown(instance: MarkdownInstance, width: number): MarkdownInstance {
  const options = instance.options as (MarkdownInstance["options"] & { transform?: (text: string, width: number) => string });
  const native = instance.cachedTokens instanceof WeakRef
    ? instance.cachedTokens.deref() as { source?: string } | undefined : undefined;
  // Prefer the text used by the host; never call a dynamic transformer at
  // copy time. Keep neither the mutable component nor a strong token tree.
  const text = options?.transform
    ? native?.source ?? options.transform(instance.text, Math.max(1, width - instance.paddingX * 2)) ?? instance.text
    : instance.text;
  return Object.assign(Object.create(Object.getPrototypeOf(instance)), {
    text, paddingX: instance.paddingX, paddingY: instance.paddingY, theme: instance.theme,
    defaultTextStyle: instance.defaultTextStyle, options: { renderLatex: options?.renderLatex }, cachedTokens: instance.cachedTokens,
  });
}

/**
 * Visible content of a host row inside its left margin. The slow path is the
 * column-correct slice (ANSI-preserving sliceByColumn + strip); the fast path
 * strips ANSI first and cuts the known run of margin spaces by chars, which is
 * identical for the well-formed rows the host produces (margins are plain
 * spaces; the comparison callers trimEnd, so the right margin needs no slice).
 * A non-conforming row falls back to the slow slice — a wrong answer here
 * would corrupt copy, a fallback only costs fidelity.
 */
function hostRowInner(hostRow: string, padX: number, contentWidth: number, fns: AdapterHostFns): string {
  const plain = fns.stripAnsi(hostRow);
  let margin = 0;
  while (margin < padX && plain.charCodeAt(margin) === 0x20) margin++;
  if (margin === padX) return plain.slice(padX);
  return fns.stripTerminalSequences(fns.sliceByColumn(hostRow, padX, contentWidth, true));
}

/** Add left/right margin decoration spans and shift content spans. */
function marginRow(row: CopyRow, padX: number, width: number, contentWidth: number): CopyRow {
  return {
    ...row,
    spans: [
      { colStart: 0, colEnd: padX, kind: "decoration" },
      ...row.spans.map((span) => ({ ...span, colStart: span.colStart + padX, colEnd: span.colEnd + padX })),
      { colStart: padX + contentWidth, colEnd: width, kind: "decoration" },
    ],
  };
}

export function wrapTextPrototype(prototype: object, deps: WrapDeps): boolean {
  return wrapRenderPrototype<TextInstance>(prototype, TEXT_COPY_OWNER, deps,
    ({ text, paddingX, paddingY }) => ({ text, paddingX, paddingY }), buildTextProduct,
    { built: "textBuilt", degraded: "textDegraded", fallback: "text mirror failed" });
}

function buildTextProduct(instance: TextInstance, width: number, frame: MirrorFrame, deps: WrapDeps): CopyProduct | undefined {
  if (!instance.text.trim()) return undefined;
  const padX = Math.min(instance.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
  const contentWidth = Math.max(1, width - padX * 2);
  const normalized = instance.text.replace(/\t/g, "   ");
  const output = assembleRows({ instance, fns: deps.fns },
    [{ segments: [{ styled: normalized, kind: "content" }] }], contentWidth, deps.hostWrap);
  return verifyRows(frame, output, { width, contentWidth, padX, padY: instance.paddingY }, deps);
}

/** Verify only the rows the frame kept, with their original position and total height. */
function verifyRows(
  frame: MirrorFrame,
  output: MirrorOutput,
  { width, contentWidth, padX, padY }: { width: number; contentWidth: number; padX: number; padY: number },
  { fns, diagnostics }: WrapDeps,
): CopyProduct | undefined {
  if (frame.total !== padY * 2 + output.styledRows.length) {
    diagnostics.lastDegradedReason = "row count mismatch";
    return undefined;
  }
  const rows: CopyRow[] = [];
  for (let i = 0; i < frame.lines.length; i++) {
    const row = frame.start + i - padY;
    if (row < 0 || row >= output.copyRows.length) {
      rows.push(decorationRow(width));
      continue;
    }
    const visible = hostRowInner(frame.lines[i]!, padX, contentWidth, fns).trimEnd();
    if (visible !== stripAnsi(output.styledRows[row]!).trimEnd()) {
      diagnostics.lastDegradedReason = `content mismatch at row ${row}`;
      return undefined;
    }
    rows.push(marginRow(output.copyRows[row]!, padX, width, contentWidth));
  }
  return { width, rows };
}
