// Width-aware Codex exec-cell layout on a PHYSICAL-ROW model.
// Wrapped VisualRows each cost exactly one screen row and are what get budgeted.
// Wrap cost and budget can never disagree. Display-only.

import { sanitizeShellLine, DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";
import { styleToolOutputLine } from "./output-style.ts";
import { highlightBashScript } from "./bash-lexer.ts";
import type { CopyRow } from "./selection-copy/model.ts";
import { stripAnsi, styledParts, wrapWithProvenance } from "./selection-copy/wrap.ts";
import { truncateToWidth as truncateStyled } from "@earendil-works/pi-tui";

export const COMMAND_CONTINUATION_PREFIX = "  │ ";
export const OUTPUT_INITIAL_PREFIX = "  └ ";
export const OUTPUT_SUBSEQUENT_PREFIX = "    ";
export const COMMAND_CONTINUATION_MAX_ROWS = 2;
export const OUTPUT_MAX_ROWS = 5;

import type { DiffLayoutOps } from "./render-contract.ts";

export type LayoutOps = DiffLayoutOps;

export interface ExecRowModel {
  /** "Running" while streaming, "Ran" once done. Empty = no title. */
  readonly title: string;
  readonly isError: boolean;
  readonly isPartial: boolean;
  readonly command: string;
  readonly language: "bash" | "powershell";
  readonly output: string;
  readonly expanded: boolean;
  readonly expandHint: string;
}

/** One physical screen row: styled text, already wrapped, cost = 1. */
export interface VisualRow {
  readonly text: string;
  /** Copy source and boundary produced alongside this physical row. */
  readonly copy?: CopyRow;
  /** Index of the logical line this row came from (-1 = synthetic, e.g. ellipsis). */
  readonly sourceLineIndex: number;
  /** True for wrapped continuation segments and command "│" rows. */
  readonly continuation: boolean;
}

const MAX_LOGICAL_LINE_CHARS = 1200;
const COPY_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const detach = (text: string) => text ? Buffer.from(text, "utf16le").toString("utf16le") : "";

/** The Pi layout binding can bulk-wrap long printable ASCII without the host's
 * per-grapheme long-word allocations. Keep its word/space boundary rules; all
 * styled, Unicode, multiline, short or unusual-width input stays with the host.
 * Custom LayoutOps are untouched unless their owner opts into this binding. */
export function wrapPlainOutput(text: string, width: number, host: LayoutOps["wrap"]): string[] {
  if (text.length < 4096 || !Number.isInteger(width) || width < 1 || /[^\x20-\x7e]/.test(text)) return host(text, width);
  if (text.length <= width) return [text];
  const rows: string[] = [];
  let line = "";
  for (const match of text.matchAll(/ +|[^ ]+/g)) {
    const token = match[0], whitespace = token[0] === " ";
    if (token.length > width && !whitespace) {
      if (line) rows.push(line.trimEnd());
      let start = 0;
      for (; start + width < token.length; start += width) rows.push(token.slice(start, start + width));
      line = token.slice(start);
    } else if (line.length + token.length > width && line.length > 0) {
      rows.push(line.trimEnd());
      line = whitespace ? "" : token;
    } else {
      line += token;
    }
  }
  if (line) rows.push(line.trimEnd());
  return rows;
}

/**
 * Length cap for oversized logical lines. ANSI-aware: escape sequences are
 * preserved verbatim (never cut mid-sequence); only visible characters count
 * against the cap and a grapheme is retained whole or omitted whole.
 */
function shorten(line: string): string {
  // The cap counts visible chars only — raw length includes ANSI sequences.
  if (stripAnsi(line).length <= MAX_LOGICAL_LINE_CHARS) return line;
  let out = "";
  let visible = 0;
  for (const part of styledParts(line)) {
    if (part.ansi !== undefined) {
      out += part.ansi;
      continue;
    }
    const grapheme = part.grapheme!;
    if (visible + grapheme.length > MAX_LOGICAL_LINE_CHARS) break;
    out += grapheme;
    visible += grapheme.length;
  }
  return `${out} …`;
}

/**
 * Codex truncate_lines_middle on VisualRows: head/tail around an ellipsis
 * row, budgeted in physical rows. The ellipsis row itself costs 1 and its
 * own wrap cost is accounted for by the caller when chosen. Returns the
 * kept rows plus the number of hidden logical lines (for a stable hint).
 */
export function truncateMiddleRows(
  rows: readonly VisualRow[],
  maxRows: number,
  expandHint: string,
  prefix: string,
  width = 80,
): { rows: VisualRow[]; omittedLogicalLines: number } {
  if (maxRows <= 0) return { rows: [], omittedLogicalLines: rows.length };
  if (rows.length <= maxRows) return { rows: [...rows], omittedLogicalLines: 0 };

  // Ellipsis body wrap cost at the caller's real width (Codex
  // output_ellipsis_row_count), so the total stays within budget.
  const ellipsisRows = Math.max(1, Math.ceil(
    (prefix.length + `… +1 lines (${expandHint})`.length) / Math.max(1, width),
  ));
  const ellipsisText = (n: number): string => {
    const plural = n === 1 ? "" : "s";
    return truncateToWidth(
      `${prefix}… +${n} line${plural} (${expandHint})`,
      Math.max(1, width),
    );
  };
  if (ellipsisRows >= maxRows) {
    const total = countLogicalLines(rows);
    const text = `${DIM_ON}${ellipsisText(Math.max(total, 1))}${INTENSITY_RESET}`;
    return { rows: [{ text, sourceLineIndex: -1, continuation: false }], omittedLogicalLines: total };
  }
  const available = maxRows - ellipsisRows;
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;

  const head = rows.slice(0, headBudget);
  const tailStart = Math.max(head.length, rows.length - Math.floor(tailBudget));
  const tail = rows.slice(tailStart);
  const headEnd = head.length;
  const omittedLogicalLines = countLogicalLines(rows.slice(headEnd, tailStart));
  const omittedRows = rows.length - head.length - tail.length;
  const n = Math.max(omittedLogicalLines, omittedRows, 1);
  const ellipsis = `${DIM_ON}${ellipsisText(n)}${INTENSITY_RESET}`;
  return {
    rows: [...head, { text: ellipsis, sourceLineIndex: -1, continuation: false }, ...tail],
    omittedLogicalLines,
  };
}

/** Hard-cut a styled string to a visible width, keeping escape sequences. */
function truncateToWidth(text: string, maxWidth: number): string {
  return truncateStyled(text, maxWidth, "");
}

function countLogicalLines(rows: readonly VisualRow[]): number {
  const seen = new Set<number>();
  for (const row of rows) if (row.sourceLineIndex >= 0) seen.add(row.sourceLineIndex);
  return seen.size;
}

/** Codex limit_lines_from_start: keep head rows plus one width-capped
 * ellipsis row. */
export function limitFromStartRows(
  rows: readonly VisualRow[],
  keep: number,
  hiddenHint: string,
  maxWidth = 80,
): VisualRow[] {
  if (rows.length <= keep) return [...rows];
  if (keep <= 0) {
    return [{ text: hiddenHint, sourceLineIndex: -1, continuation: false }];
  }
  const hidden = rows.length - keep;
  const n = Math.max(hidden, 1);
  const plural = n === 1 ? "" : "s";
  const maxBodyWidth = maxWidth - COMMAND_CONTINUATION_PREFIX.length - 1;
  const ellipsis = truncateToWidth(
    `… +${n} more command line${plural}`,
    Math.max(1, maxBodyWidth),
  );
  return [
    ...rows.slice(0, keep),
    { text: ellipsis, sourceLineIndex: -1, continuation: false },
  ];
}

export interface ShellLayoutInput {
  readonly row: ExecRowModel;
  readonly width: number;
  readonly layout: LayoutOps;
  readonly colorLevel: ColorLevel;
  /** Bullet character already colored by the caller (theme-aware). */
  readonly bullet: string;
  readonly titlePainter: (title: string) => string;
  /** Selection-copy provenance collector: one CopyRow per returned visual
   * row, appended in render order. Absent = no provenance (all native). */
  readonly copyOut?: CopyRow[];
}

function highlightCommandLines(row: ExecRowModel, colorLevel: ColorLevel): string[] {
  const logical = row.command ? row.command.split("\n") : [];
  if (!logical.length) return [];
  if (row.language === "bash") {
    return highlightBashScript(logical, colorLevel).map(shorten);
  }
  return logical.map((line) => shorten(line));
}

function wrapStyled(text: string, width: number, layout: LayoutOps, measured?: readonly string[]): Pick<VisualRow, "text" | "copy">[] {
  const usable = Math.max(1, width);
  const chunks = measured ?? layout.wrap(text, usable);
  const rows = chunks.length ? chunks : [""];
  const source = wrapWithProvenance([{ styled: text, kind: "content" }], usable, layout.visibleWidth);
  const matches = rows.length === source.length && rows.every((row, i) => stripAnsi(row).trimEnd() === stripAnsi(source[i]!.styled).trimEnd());
  return rows.map((row, i) => ({
    text: row,
    copy: matches ? {
      spans: source[i]!.spans,
      breakBefore: source[i]!.hard ? "hard" : "soft",
      bridge: source[i]!.bridge,
    } : undefined,
  }));
}

type OutputRow = VisualRow & { segmentIndex: number; sourceCopy?: CopyRow };

/** Match native rows in source order, attaching detached copy data only to the
 * kept rows. Drift uses wrapStyled; hidden continuations get no copy objects. */
function attachOutputCopies(text: string, rows: readonly string[], layout: LayoutOps, selected: readonly OutputRow[]): boolean {
  const source = stripAnsi(text);
  const graphemes = /^[\x20-\x7e]*$/.test(source) ? undefined : COPY_GRAPHEMES.segment(source);
  const boundary = (offset: number) => offset === source.length || !graphemes || graphemes.containing(offset)?.index === offset;
  let offset = 0, next = 0;
  for (let index = 0; index < rows.length; index++) {
    const plain = stripAnsi(rows[index]!);
    const start = source.indexOf(plain, offset);
    // Native soft wraps can consume whitespace, but never other source text.
    if (start < 0 || (index === 0 && start !== 0) || source.slice(offset, start).trim() !== "") return false;
    const end = start + plain.length;
    const visual = selected[next];
    if (visual?.segmentIndex === index) {
      if (!boundary(start) || !boundary(end)) return false;
      visual.sourceCopy = {
        spans: plain ? [{ colStart: 0, colEnd: layout.visibleWidth(rows[index]!), kind: "content", text: detach(plain) }] : [],
        breakBefore: index === 0 ? "hard" : "soft",
        bridge: selected[next - 1]?.segmentIndex === index - 1 ? detach(source.slice(offset, start)) : "",
      };
      next++;
    }
    offset = end;
  }
  return offset === source.length;
}

/** Keep display styling out of source coordinates; unknown host rows retain
 * native extraction over their content cells, excluding our gutter. */
function gutterCopyRow(visual: Pick<VisualRow, "text" | "copy">, gutterWidth: number, input: ShellLayoutInput): CopyRow {
  const source: CopyRow = visual.copy ?? {
    spans: [{ colStart: 0, colEnd: input.layout.visibleWidth(visual.text), kind: "unknown" }],
    breakBefore: "unknown",
  };
  return {
    ...source,
    spans: [
      { colStart: 0, colEnd: gutterWidth, kind: "decoration" },
      ...source.spans.map(span => ({ ...span, colStart: span.colStart + gutterWidth, colEnd: span.colEnd + gutterWidth })),
    ],
  };
}

/**
 * Command block: header row (bullet + bold title + first wrapped segment)
 * plus "  │ " continuation rows, capped at COMMAND_CONTINUATION_MAX_ROWS.
 * Call region only — never renders output.
 */
export function renderShellCall(input: ShellLayoutInput): string[] {
  const { row, width, layout } = input;
  const usable = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  const copy = input.copyOut;
  const styledSpan = (start: number, text: string, kind: CopyRow["spans"][number]["kind"]): CopyRow["spans"][number] => ({
    colStart: start,
    colEnd: start + layout.visibleWidth(text),
    kind,
    // Span text must be plain visible text: the serializer slices and copies it verbatim.
    text: kind === "decoration" ? undefined : layout.visibleWidth(text) > 0 ? stripAnsi(text) : undefined,
  });
  const pushGapRow = (text: string): void => {
    lines.push(text);
    copy?.push({
      spans: [{ colStart: 0, colEnd: Math.max(1, layout.visibleWidth(text)), kind: "semantic", text: stripAnsi(text) }],
      breakBefore: "gap",
    });
  };

  const titleStyled = row.title ? `${input.titlePainter(row.title)} ` : "";
  const headerPrefix = `${input.bullet} ${titleStyled}`;
  const headerPrefixWidth = layout.visibleWidth(headerPrefix);
  // Extremely narrow terminals: shorten the prefix so every row stays within
  // the terminal width (the Codex layout also degrades its prefixes).
  const headerFits = headerPrefixWidth <= usable;
  const headerPrefixFinal = headerFits ? headerPrefix : truncateToWidth(headerPrefix, usable);
  const headerPrefixFinalWidth = Math.min(headerPrefixWidth, usable);

  const highlighted = highlightCommandLines(row, input.colorLevel);
  const continuationWidth = Math.max(1, usable - layout.visibleWidth(COMMAND_CONTINUATION_PREFIX));
  const firstLineWidth = Math.max(1, usable - headerPrefixFinalWidth);

  if (!highlighted.length) {
    const header = `${headerPrefixFinal}`.trimEnd();
    lines.push(header);
    copy?.push({
      spans: [styledSpan(0, header, "content")],
      breakBefore: "hard",
    });
    return lines;
  }

  // Wrap the full highlighted script BEFORE any budget (Codex order); every segment becomes a VisualRow.
  const firstWrapped = headerFits && usable - headerPrefixFinalWidth >= 1
    ? wrapStyled(highlighted[0]!, firstLineWidth, layout)
    : [{ text: "" }];
  const rest: VisualRow[] = [];
  for (let i = 1; i < highlighted.length; i++) {
    for (const segment of wrapStyled(highlighted[i]!, continuationWidth, layout)) {
      rest.push({ ...segment, sourceLineIndex: i, continuation: true });
    }
  }

  const header = `${headerPrefixFinal}${firstWrapped[0]!.text}`;
  lines.push(header);
  copy?.push(gutterCopyRow(firstWrapped[0]!, headerPrefixFinalWidth, input));

  const continuationRows: VisualRow[] = firstWrapped.slice(1)
    .map((segment) => ({ ...segment, sourceLineIndex: 0, continuation: true }));
  continuationRows.push(...rest);
  if (!continuationRows.length) return lines;

  // Extremely narrow terminals: shorten the gutter so rows never exceed width.
  const gutter = COMMAND_CONTINUATION_PREFIX.length <= usable
    ? COMMAND_CONTINUATION_PREFIX
    : truncateToWidth(COMMAND_CONTINUATION_PREFIX, usable);
  const gutterWidth = layout.visibleWidth(gutter);
  const gutterRows: VisualRow[] = gutterWidth < COMMAND_CONTINUATION_PREFIX.length
    ? (usable - gutterWidth <= 0
      ? [{ text: "", sourceLineIndex: -1, continuation: false }]
      : continuationRows.flatMap((visual) =>
        wrapStyled(visual.text, usable - gutterWidth, layout)
          .map((segment) => ({ ...segment, sourceLineIndex: visual.sourceLineIndex, continuation: true })),
      ))
    : continuationRows;

  if (row.expanded) {
    for (const visual of gutterRows) {
      lines.push(`${DIM_ON}${gutter}${INTENSITY_RESET}${visual.text}`);
      copy?.push(gutterCopyRow(visual, gutterWidth, input));
    }
    return lines;
  }
  const capped = limitFromStartRows(
    gutterRows,
    COMMAND_CONTINUATION_MAX_ROWS,
    `… more command lines`,
    usable,
  );
  for (const visual of capped) {
    const styled = `${DIM_ON}${gutter}${INTENSITY_RESET}${visual.text}`;
    if (visual.sourceLineIndex === -1 && visual !== gutterRows[0]) {
      // Ellipsis row: a visible hint; the hidden lines behind it are a gap.
      pushGapRow(styled);
    } else {
      lines.push(styled);
      copy?.push(gutterCopyRow(visual, gutterWidth, input));
    }
  }
  return lines;
}

/**
 * Output block: "  └ " first row, "    " after, wrapped then middle-truncated
 * to OUTPUT_MAX_ROWS physical rows. Result region only — never a command head.
 * Streaming (isPartial) shows the bounded tail; done shows head+tail.
 * Prefix choice follows the original wrapped position (Codex prefix_lines
 * order); only retained rows materialize it, so a tail never becomes a head.
 */
export function renderShellResult(input: ShellLayoutInput): string[] {
  const { row, width, layout } = input;
  const usable = Math.max(1, Math.floor(width));
  // When the gutter consumes the whole terminal, give the output its column.
  const initialPrefix = usable <= layout.visibleWidth(OUTPUT_INITIAL_PREFIX) ? "" : OUTPUT_INITIAL_PREFIX;
  const subsequentPrefix = usable <= layout.visibleWidth(OUTPUT_SUBSEQUENT_PREFIX) ? "" : OUTPUT_SUBSEQUENT_PREFIX;
  const outputWidth = Math.max(1, usable - layout.visibleWidth(subsequentPrefix));
  const copy = input.copyOut;
  const initialPrefixWidth = layout.visibleWidth(initialPrefix);
  const subsequentPrefixWidth = layout.visibleWidth(subsequentPrefix);

  const raw = row.output ? sanitizeShellLine(row.output).split("\n") : [];
  while (raw.length && raw.at(-1) === "") raw.pop();
  if (!raw.length) {
    const noOutput = styleToolOutputLine(
      truncateToWidth(usable <= 4 ? "∅" : `${initialPrefix}(no output)`, usable),
      { dim: true, colorLevel: input.colorLevel },
    );
    copy?.push({ spans: [{ colStart: 0, colEnd: usable, kind: "decoration" }], breakBefore: "hard" });
    return [noOutput];
  }

  // Wrap first (Codex), record prefix choice, then budget — long lines cannot
  // flood the viewport and "  └ " still marks the original head. The whole body
  // (prefix + text) is dimmed through the SGR state machine: source colors
  // survive, internal resets re-acquire DIM, and our DIM never leaks out.
  const dimPolicy = { dim: true, colorLevel: input.colorLevel };
  const wrapped: OutputRow[] = [];
  // Native wrapping still decides the exact row count/hint. Defer styling and
  // provenance for hidden middle lines until after the physical-row budget.
  const measured = raw.map(logical => {
    const chunks = layout.wrap(logical, outputWidth);
    return chunks.length ? chunks : [""];
  });
  measured.forEach((segments, lineIndex) => {
    segments.forEach((text, segmentIndex) => {
      wrapped.push({ text, sourceLineIndex: lineIndex, segmentIndex,
        continuation: lineIndex !== 0 || segmentIndex !== 0 });
    });
  });

  const kept = row.expanded ? wrapped : row.isPartial
    ? wrapped.slice(-OUTPUT_MAX_ROWS)
    : truncateMiddleRows(wrapped, OUTPUT_MAX_ROWS, row.expandHint, subsequentPrefix, usable).rows;
  let sourceLine = -1, afterGap = false;
  return kept.map((visual, index) => {
    if (visual.sourceLineIndex === -1) {
      copy?.push({ spans: [{ colStart: 0, colEnd: usable, kind: "semantic", text: stripAnsi(visual.text) }], breakBefore: "gap" });
      afterGap = true;
      return visual.text;
    }
    if (copy) {
      if (sourceLine !== visual.sourceLineIndex) {
        sourceLine = visual.sourceLineIndex;
        const selected = (row.expanded ? kept.slice(index, index + measured[sourceLine]!.length)
          : kept.filter(item => item.sourceLineIndex === sourceLine)) as OutputRow[];
        if (!attachOutputCopies(raw[sourceLine]!, measured[sourceLine]!, layout, selected)) {
          const segments = wrapStyled(raw[sourceLine]!, outputWidth, layout, measured[sourceLine]);
          for (const item of selected) item.sourceCopy = segments[item.segmentIndex]!.copy;
        }
      }
      // truncateMiddleRows only synthesizes sourceLineIndex=-1 notices; real
      // rows retain their original segment coordinate even across a gap.
      const { segmentIndex, sourceCopy } = visual as OutputRow;
      const prefixWidth = sourceLine === 0 && segmentIndex === 0 ? initialPrefixWidth : subsequentPrefixWidth;
      const original = gutterCopyRow({ text: visual.text, copy: sourceCopy }, prefixWidth, input);
      copy.push(afterGap ? { ...original, breakBefore: "gap" }
        : !row.expanded && row.isPartial && index === 0 ? { ...original, breakBefore: "hard" } : original);
    }
    afterGap = false;
    // Bulk word wrapping uses slices. A committed visible row must not keep
    // the entire hidden logical line alive after its component is released.
    return styleToolOutputLine(detach(`${visual.continuation ? subsequentPrefix : initialPrefix}${visual.text}`), dimPolicy);
  });
}
