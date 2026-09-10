// Width-aware Codex exec-cell layout (openai/codex exec_cell/render.rs,
// EXEC_DISPLAY_LAYOUT: continuation "  │ " max 2 rows, output "  └ "/"    "
// max 5 rows, middle truncation budgeted in screen rows).
//
// Physical-row model: logical text -> styled lines -> wrap (ANSI-aware) ->
// VisualRow[] (each costs exactly 1) -> budget cut -> prefixes. Wrapped rows
// and their costs can never disagree because they are the same array.
// Display-only: never touches tool data.

import { sanitizeShellLine, DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";
import { highlightBashScript } from "./bash-lexer.ts";

export const COMMAND_CONTINUATION_PREFIX = "  │ ";
export const OUTPUT_INITIAL_PREFIX = "  └ ";
export const OUTPUT_SUBSEQUENT_PREFIX = "    ";
export const COMMAND_CONTINUATION_MAX_ROWS = 2;
export const OUTPUT_MAX_ROWS = 5;

export interface LayoutOps {
  wrap(text: string, width: number): string[];
  visibleWidth(text: string): number;
}

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
  if (line.length <= MAX_LOGICAL_LINE_CHARS) return line;
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isWhitespaceOnly(text: string): boolean {
  return stripAnsi(text).trim() === "";
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
    // Budget only fits the ellipsis (possibly spanning rows): single notice.
    const total = countLogicalLines(rows);
    const text = `${DIM_ON}${ellipsisText(Math.max(total, 1))}${INTENSITY_RESET}`;
    return { rows: [{ text, sourceLineIndex: -1, continuation: false }], omittedLogicalLines: total };
  }
  const available = maxRows - ellipsisRows;
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;

  let headRows = 0;
  let headEnd = 0;
  const head: VisualRow[] = [];
  while (headEnd < rows.length) {
    if (headRows + 1 > headBudget) break;
    headRows += 1;
    head.push(rows[headEnd]!);
    headEnd += 1;
  }
  let tailRows = 0;
  let tailStart = rows.length;
  const tail: VisualRow[] = [];
  while (tailStart > headEnd) {
    if (tailRows + 1 > tailBudget) break;
    tailRows += 1;
    tail.unshift(rows[tailStart - 1]!);
    tailStart -= 1;
  }
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
  let out = "";
  let cells = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    if (cells + 1 > maxWidth) break;
    out += char;
    cells += 1;
    index += 1;
  }
  return out;
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
}

function highlightCommandLines(row: ExecRowModel, colorLevel: ColorLevel): string[] {
  const logical = row.command ? row.command.split("\n") : [];
  if (!logical.length) return [];
  if (row.language === "bash") {
    return highlightBashScript(logical, colorLevel).map(shorten);
  }
  return logical.map((line) => shorten(line));
}

function wrapStyled(text: string, width: number, layout: LayoutOps): string[] {
  const chunks = layout.wrap(text, Math.max(1, width));
  return chunks.length ? chunks : [""];
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
    lines.push(`${headerPrefixFinal}`.trimEnd());
    return lines;
  }

  // Wrap the full highlighted script BEFORE any budget (Codex order), then
  // split into the header row and "│" rows. Every segment becomes a VisualRow.
  const firstWrapped = headerFits && usable - headerPrefixFinalWidth >= 1
    ? wrapStyled(highlighted[0]!, firstLineWidth, layout)
    : [""];
  const rest: VisualRow[] = [];
  for (let i = 1; i < highlighted.length; i++) {
    for (const segment of wrapStyled(highlighted[i]!, continuationWidth, layout)) {
      rest.push({ text: segment, sourceLineIndex: i, continuation: true });
    }
  }

  lines.push(`${headerPrefixFinal}${firstWrapped[0]!}`.trimEnd());

  const continuationRows: VisualRow[] = firstWrapped.slice(1)
    .map((segment) => ({ text: segment, sourceLineIndex: 0, continuation: true }));
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
        wrapStyled(stripOwnPrefix(visual.text), usable - gutterWidth, layout)
          .map((segment) => ({ text: segment, sourceLineIndex: visual.sourceLineIndex, continuation: true })),
      ))
    : continuationRows;

  if (row.expanded) {
    for (const visual of gutterRows) {
      lines.push(`${DIM_ON}${gutter}${INTENSITY_RESET}${visual.text}`);
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
    lines.push(`${DIM_ON}${gutter}${INTENSITY_RESET}${stripOwnPrefix(visual.text)}`);
  }
  return lines;
}

function stripOwnPrefix(text: string): string {
  // Ellipsis rows produced by limitFromStartRows already carry dim + "…";
  // regular segments are re-prefixed with the continuation gutter.
  return text;
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
  const outputWidth = Math.max(1, usable - layout.visibleWidth(OUTPUT_SUBSEQUENT_PREFIX));

  const raw = row.output ? sanitizeShellLine(row.output).split("\n") : [];
  while (raw.length && raw.at(-1) === "") raw.pop();
  if (!raw.length) {
    return [`${DIM_ON}${OUTPUT_INITIAL_PREFIX}(no output)${INTENSITY_RESET}`];
  }

  // Wrap first (Codex), attach prefixes, then budget — a few very long lines
  // cannot flood the viewport and "  └ " marks the block head.
  const wrapped: VisualRow[] = [];
  raw.forEach((logical, lineIndex) => {
    const segments = wrapStyled(logical, outputWidth, layout);
    segments.forEach((segment, segmentIndex) => {
      const prefix = lineIndex === 0 && segmentIndex === 0 ? OUTPUT_INITIAL_PREFIX : OUTPUT_SUBSEQUENT_PREFIX;
      wrapped.push({
        text: `${DIM_ON}${prefix}${INTENSITY_RESET}${segment}`,
        sourceLineIndex: lineIndex,
        continuation: lineIndex !== 0 || segmentIndex !== 0,
      });
    });
  });

  let kept: VisualRow[];
  if (row.expanded) {
    kept = wrapped; // wrapped, never truncated: full text remains reachable
  } else if (row.isPartial) {
    // Streaming: bounded tail (Codex shows the newest rows).
    kept = wrapped.slice(-OUTPUT_MAX_ROWS);
  } else {
    // Budget includes the ellipsis row's own cost.
    kept = truncateMiddleRows(wrapped, OUTPUT_MAX_ROWS, row.expandHint, OUTPUT_SUBSEQUENT_PREFIX, usable).rows;
  }

  return kept.map((visual) => visual.text);
}

/**
 * Full single-component render (call + result in one). Kept for non-component
 * hosts and tests; the live Pi adapter uses renderShellCall/renderShellResult
 * in the two native slots. The composition is identical by construction.
 */
export function renderShellRow(input: ShellLayoutInput): string[] {
  return [...renderShellCall(input), ...renderShellResult(input)];
}
