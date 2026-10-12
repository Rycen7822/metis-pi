// Width-aware Codex exec-cell layout on a PHYSICAL-ROW model.
// Wrapped VisualRows each cost exactly one screen row and are what get budgeted.
// Wrap cost and budget can never disagree. Display-only.

import { sanitizeShellLine, DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";
import { styleToolOutputLine } from "./output-style.ts";
import { highlightBashScript } from "./bash-lexer.ts";
import type { CopyRow } from "./selection-copy/model.ts";
import { stripAnsi, wrapWithProvenance } from "./selection-copy/wrap.ts";
import { truncateToWidth as truncateStyled } from "@earendil-works/pi-tui";

export const COMMAND_CONTINUATION_PREFIX = "  │ ";
export const OUTPUT_INITIAL_PREFIX = "  └ ";
export const OUTPUT_SUBSEQUENT_PREFIX = "    ";
export const COMMAND_CONTINUATION_MAX_ROWS = 2;
export const OUTPUT_MAX_ROWS = 5;

import type { DiffLayoutOps } from "./tool-names.ts";

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

/**
 * Length cap for oversized logical lines. ANSI-aware: escape sequences are
 * preserved verbatim (never cut mid-sequence); only VISIBLE characters count
 * against the cap. A trailing lone surrogate is dropped to avoid splits.
 */
function shorten(line: string): string {
  // The cap counts visible chars only — raw length includes ANSI sequences.
  if (stripAnsi(line).length <= MAX_LOGICAL_LINE_CHARS) return line;
  let out = "";
  let visible = 0;
  let index = 0;
  while (index < line.length && visible < MAX_LOGICAL_LINE_CHARS) {
    const char = line[index]!;
    if (char === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    out += char;
    visible += 1;
    index += 1;
  }
  return `${out.replace(/[\ud800-\udbff]$/, "")} …`;
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
  const hiddenLogical = countLogicalLines(rows.slice(keep));
  const n = Math.max(hiddenLogical, hidden, 1);
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

function wrapStyled(text: string, width: number, layout: LayoutOps): Pick<VisualRow, "text" | "copy">[] {
  const usable = Math.max(1, width);
  const chunks = layout.wrap(text, usable);
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
 * Prefixes are attached right after wrapping (Codex prefix_lines order), so
 * the "  └ " head survives truncation exactly like the upstream cell.
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

  // Wrap first (Codex), attach prefixes, then budget — a few very long lines
  // cannot flood the viewport and "  └ " marks the block head. The whole body
  // (prefix + text) is dimmed through the SGR state machine: source colors
  // survive, internal resets re-acquire DIM, and our DIM never leaks out.
  const dimPolicy = { dim: true, colorLevel: input.colorLevel };
  const wrapped: VisualRow[] = [];
  const copyRows: CopyRow[] = [];
  raw.forEach((logical, lineIndex) => {
    const segments = wrapStyled(logical, outputWidth, layout);
    segments.forEach((segment, segmentIndex) => {
      const isFirst = lineIndex === 0 && segmentIndex === 0;
      const prefix = isFirst ? initialPrefix : subsequentPrefix;
      const prefixWidth = isFirst ? initialPrefixWidth : subsequentPrefixWidth;
      wrapped.push({
        text: styleToolOutputLine(`${prefix}${segment.text}`, dimPolicy),
        sourceLineIndex: lineIndex,
        continuation: lineIndex !== 0 || segmentIndex !== 0,
      });
      copyRows.push(gutterCopyRow(segment, prefixWidth, input));
    });
  });

  let kept: VisualRow[];
  let keptCopy: CopyRow[];
  if (row.expanded) {
    kept = wrapped; // wrapped, never truncated: full text remains reachable
    keptCopy = copyRows;
  } else if (row.isPartial) {
    // Streaming: bounded tail (Codex shows the newest rows). Only the first
    // kept row may be mid-logical-line; soft joins among kept rows stay valid.
    const from = Math.max(0, wrapped.length - OUTPUT_MAX_ROWS);
    kept = wrapped.slice(from);
    keptCopy = copyRows.slice(from).map((copyRow, index) => (index === 0 ? { ...copyRow, breakBefore: "hard" as const } : copyRow));
  } else {
    // Budget includes the ellipsis row's own cost.
    const truncated = truncateMiddleRows(wrapped, OUTPUT_MAX_ROWS, row.expandHint, subsequentPrefix, usable);
    kept = truncated.rows;
    keptCopy = [];
    let afterGap = false;
    for (const visual of truncated.rows) {
      if (visual.sourceLineIndex === -1) {
        // Ellipsis row: visible hint; the hidden lines behind it are a gap.
        keptCopy.push({
          spans: [{ colStart: 0, colEnd: usable, kind: "semantic", text: stripAnsi(visual.text) }],
          breakBefore: "gap",
        });
        afterGap = true;
        continue;
      }
      const original = copyRows[wrapped.indexOf(visual)];
      if (original) {
        keptCopy.push(afterGap ? { ...original, breakBefore: "gap" } : original);
      }
      afterGap = false;
    }
  }

  copy?.push(...keptCopy);
  return kept.map((visual) => visual.text);
}
