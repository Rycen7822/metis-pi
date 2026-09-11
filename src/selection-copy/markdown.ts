// Text/Markdown provenance adapters. Both wrap prototype.render: the host
// render runs untouched (its output is the truth on screen), then a mirror
// pipeline rebuilds the same rows WITH copy provenance. The mirror's rows are
// diffed against the host's real rows positionally; any mismatch drops the
// product for that render (native extraction instead) — host drift or exotic
// content degrades rather than corrupts.
//
// The Markdown mirror reuses the live instance for everything textual
// (renderInlineTokens, theme painters, highlightCode, and renderToken itself
// for token types without a provenance mirror — tables, unknown nodes) and
// replicates only the structural pipeline: transform → tab normalization →
// lexer → per-token line assembly → wrap layers (outer at contentWidth; list
// items at itemWidth; blockquote content at width-2).

import {
  decorationRow,
  registerProduct,
  type BreakBefore,
  type CopyProduct,
  type CopyRow,
} from "./model.ts";
import { visibleOfStyled, wrapWithProvenance } from "./wrap.ts";
import type { AdapterHostFns } from "./shared.ts";
import type { CopyLexer, MarkdownToken } from "./parser.ts";

type RenderFn = (this: MarkdownInstance, width: number) => string[];

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
  plainParts: string[];
  plainOffset: number;
}

function painter(instance: MarkdownInstance, name: string): (text: string) => string {
  const theme = instance.theme as Record<string, (text: string) => string> | undefined;
  const fn = theme?.[name];
  if (typeof fn !== "function") return (text) => text;
  return fn.bind(theme);
}

/** Record a segment's visible text and return its char offset in the plain
 * string (spans index into the product-global plain text). */
function plainLength(ctx: MirrorContext, styled: string): number {
  const visible = ctx.fns.stripAnsi(styled);
  const offset = ctx.plainOffset;
  ctx.plainParts.push(visible);
  ctx.plainOffset += visible.length;
  return offset;
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
      const rendered = token.pending !== true && instance.options?.renderLatex !== false
        ? (latexPainter?.(token.text ?? "", { display: true }) ?? (token.raw ?? "").trim())
        : (token.raw ?? "").trim();
      const lines = rendered.split("\n").map((line) => contentLine(applyDefaultStyle(instance, line)));
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "code": {
      const indent = (instance.theme as { codeBlockIndent?: string } | undefined)?.codeBlockIndent ?? "  ";
      const fence = painter(instance, "codeBlockBorder");
      const codeBlock = painter(instance, "codeBlock");
      const codeLines = (token.text ?? "").split("\n");
      const highlight = (instance.theme as { highlightCode?: (text: string, lang: string) => string[] } | undefined)?.highlightCode;
      const highlighted = highlight ? highlight(token.text ?? "", token.lang ?? "") : undefined;
      const lines: LogicalLine[] = [contentLine(fence("```" + (token.lang || "")), "semantic")];
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
      lines.push(contentLine(fence("```"), "semantic"));
      lines.push(...spacing(nextTokenType, ["space"]));
      return lines;
    }
    case "list": {
      return renderListMirror(ctx, token, 0, width, styleContext);
    }
    case "blockquote": {
      const lines = renderQuoteMirror(ctx, token, width);
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
      if (typeof token.raw === "string") {
        return [contentLine(applyDefaultStyle(instance, token.raw.trim()))];
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

function renderQuoteMirror(ctx: MirrorContext, token: MarkdownToken, width: number): LogicalLine[] {
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
  const quoteContentWidth = Math.max(1, width - 2);
  const quoteInlineStyleContext = { applyText: (text: string) => text, stylePrefix: quoteStylePrefix };
  const quoteTokens = token.tokens ?? [];
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

// ---------------------------------------------------------------------------
// Row assembly + verification
// ---------------------------------------------------------------------------

interface MirrorOutput {
  styledRows: string[];
  pendingRows: PendingRow[];
  plain: string;
}

type PendingSpanKind = "content" | "decoration" | "semantic" | "gap" | "unknown";

interface PendingRow {
  styled: string;
  spans: { colStart: number; colEnd: number; kind: PendingSpanKind; plainStart?: number; plainEnd?: number; text?: string }[];
  breakBefore: BreakBefore;
  wide: boolean;
  bridge?: string;
}

function assembleRows(
  ctx: MirrorContext,
  logicalLines: LogicalLine[],
  contentWidth: number,
  hostWrap: (text: string, width: number) => string[],
): MirrorOutput {
  const styledRows: string[] = [];
  const pendingRows: PendingRow[] = [];
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
          styledRows.push(prefix ? prefix.styled + wrapped : wrapped);
          pendingRows.push({
            styled: styledRows[styledRows.length - 1]!,
            spans: [{ colStart: 0, colEnd: Math.max(1, contentWidth), kind: "unknown" as const }],
            breakBefore: "hard",
            wide: false,
          });
          rowIndex += 1;
        }
      }
      continue;
    }
    const wrapWidth = line.inner ? line.inner.width : contentWidth;
    const segments = line.segments.map((segment) => ({
      styled: segment.styled,
      kind: segment.kind,
      plainStart: plainLength(ctx, segment.styled),
    }));
    const rows = wrapWithProvenance(segments, wrapWidth, ctx.fns.visibleWidth);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex]!;
      const prefix = line.inner
        ? (rowIndex === 0 && line.inner.firstOnRowZero ? line.inner.firstPrefix : line.inner.continuationPrefix)
        : undefined;
      styledRows.push(prefix ? prefix.styled + row.styled : row.styled);
      const spans: PendingRow["spans"] = row.spans.map((span) => ({
        colStart: span.colStart + (prefix?.cells ?? 0),
        colEnd: span.colEnd + (prefix?.cells ?? 0),
        kind: span.kind,
        plainStart: span.plainStart,
        plainEnd: span.plainEnd,
      }));
      if (prefix && prefix.cells > 0) {
        spans.unshift({ colStart: 0, colEnd: prefix.cells, kind: prefix.kind, text: prefix.text.length > 0 ? prefix.text : undefined });
      }
      const breakBefore: BreakBefore = rowIndex === 0 ? "hard" : row.hard ? "hard" : "soft";
      const pending: PendingRow = { styled: styledRows[styledRows.length - 1]!, spans, breakBefore, wide: row.wide };
      if (breakBefore === "soft") pending.bridge = row.bridge;
      pendingRows.push(pending);
    }
  }
  return { styledRows, pendingRows, plain: ctx.plainParts.join("") };
}

/** Slice span texts from the completed plain string. */
function finalizeRows(pending: PendingRow[], plain: string): CopyRow[] {
  return pending.map((row) => ({
    spans: row.spans.map((span) => ({
      colStart: span.colStart,
      colEnd: span.colEnd,
      kind: span.kind,
      text: span.text !== undefined
        ? span.text
        : span.plainStart !== undefined && span.plainEnd !== undefined && span.plainEnd > span.plainStart
          ? plain.slice(span.plainStart, span.plainEnd)
          : "",
    })),
    breakBefore: row.breakBefore,
    wide: row.wide,
    bridge: row.bridge,
  }));
}

// ---------------------------------------------------------------------------
// Prototype wrappers
// ---------------------------------------------------------------------------

export interface WrapDeps {
  fns: AdapterHostFns;
  lexer: CopyLexer;
  hostWrap: (text: string, width: number) => string[];
  diagnostics: MarkdownDiagnostics;
}

export function wrapMarkdownPrototype(prototype: object, deps: WrapDeps): boolean {
  const key = Symbol.for("Rycen7822.pi-codex-appearance.copy-markdown");
  if (Object.prototype.hasOwnProperty.call(prototype, key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as RenderFn;
  const cache = new WeakMap<object, { text: string; width: number; product: CopyProduct }>();
  const wrapper = function (this: MarkdownInstance, width: number): string[] {
    const rows = original.call(this, width);
    try {
      const cached = cache.get(this);
      if (cached && cached.text === this.text && cached.width === width) return rows;
      const product = buildMarkdownProduct(this, width, rows, deps);
      if (product) {
        registerProduct(rows, product);
        cache.set(this, { text: this.text, width, product });
        deps.diagnostics.markdownBuilt += 1;
      } else {
        deps.diagnostics.markdownDegraded += 1;
      }
    } catch (error) {
      deps.diagnostics.markdownDegraded += 1;
      deps.diagnostics.lastDegradedReason = error instanceof Error ? error.message : "mirror failed";
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  return true;
}

/** The plain string must be assembled BEFORE slicing span texts; rebuild the
 * mirror output in two passes: rows first (assigning plain offsets), then
 * slice texts. */
function buildMarkdownProduct(
  instance: MarkdownInstance,
  width: number,
  hostRows: readonly string[],
  deps: WrapDeps,
): CopyProduct | undefined {
  const fns = deps.fns;
  if (hostRows.length === 0) {
    return { componentId: "markdown", width, rows: [] };
  }
  const contentWidth = Math.max(1, width - instance.paddingX * 2);
  const text = transformText(instance, contentWidth);
  if (text === undefined) {
    deps.diagnostics.lastDegradedReason = "transform failed";
    return undefined;
  }
  if (!text || !text.trim()) {
    return undefined;
  }
  const normalized = text.replace(/\t/g, "   ");
  const ctx: MirrorContext = { instance, fns, plainParts: [], plainOffset: 0 };
  const tokens = deps.lexer.lexer(normalized);
  const logicalLines: LogicalLine[] = [];
  const styleContext = defaultStyleContext(instance);
  for (let i = 0; i < tokens.length; i++) {
    logicalLines.push(...renderTokenMirror(ctx, tokens[i]!, contentWidth, tokens[i + 1]?.type, styleContext));
  }
  const output = assembleRows(ctx, logicalLines, contentWidth, deps.hostWrap);
  // Second pass: slice span texts now that the plain string is complete.
  const copyRows = finalizeRows(output.pendingRows, output.plain);
  // Verify positionally against the host's real rows.
  const padY = instance.paddingY;
  const padX = instance.paddingX;
  if (hostRows.length !== padY * 2 + output.styledRows.length) {
    deps.diagnostics.lastDegradedReason = "row count mismatch";
    return undefined;
  }
  for (let i = 0; i < output.styledRows.length; i++) {
    const hostRow = hostRows[padY + i]!;
    const inner = fns.stripTerminalSequences(fns.sliceByColumn(hostRow, padX, contentWidth, true));
    if (inner.trimEnd() !== visibleOfStyled(output.styledRows[i]!).trimEnd()) {
      deps.diagnostics.lastDegradedReason = `content mismatch at row ${i}`;
      return undefined;
    }
  }
  const rows: CopyRow[] = [];
  for (let i = 0; i < padY; i++) rows.push(decorationRow(width));
  for (const row of copyRows) rows.push(marginRow(row, padX, width, contentWidth));
  for (let i = 0; i < padY; i++) rows.push(decorationRow(width));
  return { componentId: "markdown", width, rows };
}

function transformText(instance: MarkdownInstance, contentWidth: number): string | undefined {
  const options = instance.options as { transform?: (text: string, width: number) => string } | undefined;
  try {
    return options?.transform ? options.transform(instance.text, contentWidth) : instance.text;
  } catch {
    return undefined;
  }
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
  const key = Symbol.for("Rycen7822.pi-codex-appearance.copy-text");
  if (Object.prototype.hasOwnProperty.call(prototype, key)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable || !descriptor.writable) {
    return false;
  }
  const original = descriptor.value as RenderFn;
  const cache = new WeakMap<object, { text: string; width: number; product: CopyProduct }>();
  const wrapper = function (this: TextInstance, width: number): string[] {
    const rows = original.call(this, width);
    try {
      const cached = cache.get(this);
      if (cached && cached.text === this.text && cached.width === width) return rows;
      const product = buildTextProduct(this, width, rows, deps);
      if (product) {
        registerProduct(rows, product);
        cache.set(this, { text: this.text, width, product });
        deps.diagnostics.textBuilt += 1;
      } else {
        deps.diagnostics.textDegraded += 1;
      }
    } catch (error) {
      deps.diagnostics.textDegraded += 1;
      deps.diagnostics.lastDegradedReason = error instanceof Error ? error.message : "text mirror failed";
    }
    return rows;
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: wrapper });
  return true;
}

function buildTextProduct(
  instance: TextInstance,
  width: number,
  hostRows: readonly string[],
  deps: WrapDeps,
): CopyProduct | undefined {
  const fns = deps.fns;
  if (hostRows.length === 0) {
    return { componentId: "text", width, rows: [] };
  }
  if (!instance.text || !instance.text.trim()) {
    return undefined;
  }
  const paddingX = Math.min(instance.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
  const contentWidth = Math.max(1, width - paddingX * 2);
  const normalized = instance.text.replace(/\t/g, "   ");
  const ctx: MirrorContext = { instance, fns, plainParts: [], plainOffset: 0 };
  const output = assembleRows(
    ctx,
    [{ segments: [{ styled: normalized, kind: "content" }] }],
    contentWidth,
    deps.hostWrap,
  );
  const copyRows = finalizeRows(output.pendingRows, output.plain);
  if (hostRows.length !== instance.paddingY * 2 + output.styledRows.length) {
    deps.diagnostics.lastDegradedReason = "text row count mismatch";
    return undefined;
  }
  for (let i = 0; i < output.styledRows.length; i++) {
    const hostRow = hostRows[instance.paddingY + i]!;
    const inner = fns.stripTerminalSequences(fns.sliceByColumn(hostRow, paddingX, contentWidth, true));
    if (inner.trimEnd() !== visibleOfStyled(output.styledRows[i]!).trimEnd()) {
      deps.diagnostics.lastDegradedReason = `text content mismatch at row ${i}`;
      return undefined;
    }
  }
  const rows: CopyRow[] = [];
  for (let i = 0; i < instance.paddingY; i++) rows.push(decorationRow(width));
  for (const row of copyRows) rows.push(marginRow(row, paddingX, width, contentWidth));
  for (let i = 0; i < instance.paddingY; i++) rows.push(decorationRow(width));
  return { componentId: "text", width, rows };
}
