// Width-aware Codex exec-cell layout (openai/codex exec_cell/render.rs).
// Presents tool rows as Codex does: bullet + bold title, "  │ " command
// continuation (max 2 screen rows), "  └ "/"    " output block (max 5 screen
// rows) with middle truncation. Display-only.

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

const MAX_LOGICAL_LINE_CHARS = 1200;

function shorten(line: string): string {
  return line.length > MAX_LOGICAL_LINE_CHARS
    ? `${line.slice(0, MAX_LOGICAL_LINE_CHARS).replace(/[\ud800-\udbff]$/, "")} …`
    : line;
}

/** Codex limit_lines_from_start: keep head rows plus one ellipsis row. */
function limitFromStart(lines: readonly string[], keep: number, ellipsis: string): string[] {
  if (lines.length <= keep) return [...lines];
  if (keep === 0) return [ellipsis];
  return [...lines.slice(0, keep), ellipsis];
}

/**
 * Codex truncate_lines_middle: head/tail around an ellipsis row, budgeted in
 * screen rows (rowCounts = wrapped row count per logical input row).
 */
export function truncateMiddle(
  lines: readonly string[],
  rowCounts: readonly number[],
  maxRows: number,
  omittedHint: number,
  ellipsisText: string,
): { lines: string[]; omitted: number } {
  if (maxRows <= 0) return { lines: [], omitted: omittedHint };
  const totalRows = rowCounts.reduce((sum, count) => sum + count, 0);
  if (totalRows <= maxRows) return { lines: [...lines], omitted: omittedHint };
  const ellipsisRows = 1;
  if (ellipsisRows >= maxRows) return { lines: [ellipsisText], omitted: omittedHint };
  const available = maxRows - ellipsisRows;
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;
  let headRows = 0;
  let headEnd = 0;
  const head: string[] = [];
  while (headEnd < lines.length) {
    const rows = rowCounts[headEnd]!;
    if (headRows + rows > headBudget) break;
    headRows += rows;
    head.push(lines[headEnd]!);
    headEnd += 1;
  }
  let tailRows = 0;
  let tailStart = lines.length;
  const tail: string[] = [];
  while (tailStart > headEnd) {
    const rows = rowCounts[tailStart - 1]!;
    if (tailRows + rows > tailBudget) break;
    tailRows += rows;
    tail.unshift(lines[tailStart - 1]!);
    tailStart -= 1;
  }
  const omitted = omittedHint + (lines.length - head.length - tail.length);
  return { lines: [...head, ellipsisText, ...tail], omitted };
}

export interface RenderShellRowInput {
  readonly row: ExecRowModel;
  readonly width: number;
  readonly layout: LayoutOps;
  readonly colorLevel: ColorLevel;
  /** Bullet character already colored by the caller (theme-aware). */
  readonly bullet: string;
  readonly titlePainter: (title: string) => string;
}

/**
 * Render one exec cell. Returns final display lines (width-aware, ANSI-safe).
 */
export function renderShellRow(input: RenderShellRowInput): string[] {
  const { row, width, layout, colorLevel } = input;
  const usable = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  // ---- Header: bullet + bold title + first command segment ----------------
  const titleStyled = row.title ? `${input.titlePainter(row.title)} ` : "";
  const headerPrefix = `${input.bullet} ${titleStyled}`;
  const headerPrefixWidth = layout.visibleWidth(headerPrefix);

  const commandLines = row.command ? row.command.split("\n") : [];
  const highlighted = (row.language === "bash"
    ? highlightBashScript(commandLines, colorLevel)
    : commandLines.map((line) => shorten(line))).map(shorten);

  const continuationWidth = Math.max(1, usable - layout.visibleWidth(COMMAND_CONTINUATION_PREFIX));
  const firstLineWidth = Math.max(1, usable - headerPrefixWidth);

  // Wrap the highlighted first line and remaining lines separately; wrapping
  // is ANSI-aware via layout.wrap (Tui.wrapTextWithAnsi in the live host).
  const firstWrapped = highlighted.length ? layout.wrap(highlighted[0]!, firstLineWidth) : [""];
  const restWrapped = highlighted.slice(1)
    .flatMap((line) => layout.wrap(line, continuationWidth));

  lines.push(`${headerPrefix}${firstWrapped[0] ?? ""}`.trimEnd());

  // ---- Command continuation: "  │ ", at most 2 screen rows ----------------
  const continuationRows: string[] = [
    ...firstWrapped.slice(1),
    ...restWrapped,
  ].map((segment) => `${DIM_ON}${COMMAND_CONTINUATION_PREFIX}${INTENSITY_RESET}${segment}`);
  const continuationOmitted = continuationRows.length - COMMAND_CONTINUATION_MAX_ROWS;
  if (continuationRows.length > 0) {
    const visible = limitFromStart(
      continuationRows,
      COMMAND_CONTINUATION_MAX_ROWS,
      continuationOmitted > 0
        ? `${DIM_ON}${COMMAND_CONTINUATION_PREFIX}… +${continuationOmitted} command lines${INTENSITY_RESET}`
        : "",
    );
    lines.push(...visible);
  }

  // ---- Output block: "  └ " first row, "    " after, middle truncation ----
  if (!row.isPartial) {
    const raw = row.output ? sanitizeShellLine(row.output).split("\n") : [];
    while (raw.length && raw.at(-1) === "") raw.pop();
    if (!raw.length) {
      lines.push(`${DIM_ON}${OUTPUT_INITIAL_PREFIX}(no output)${INTENSITY_RESET}`);
    } else if (row.expanded) {
      raw.forEach((logical, index) => {
        lines.push(`${DIM_ON}${index === 0 ? OUTPUT_INITIAL_PREFIX : OUTPUT_SUBSEQUENT_PREFIX}${logical}${INTENSITY_RESET}`);
      });
    } else {
      const outputWidth = Math.max(1, usable - layout.visibleWidth(OUTPUT_SUBSEQUENT_PREFIX));
      const wrapped: string[] = [];
      const rowCounts: number[] = [];
      raw.forEach((logical, lineIndex) => {
        const chunks = layout.wrap(logical, outputWidth);
        const physical = chunks.length ? chunks : [""];
        rowCounts.push(physical.length);
        for (let i = 0; i < physical.length; i++) {
          // Codex: the first OUTPUT row gets "  └ "; everything after it
          // (later logical lines and wrapped continuations) gets 4 spaces.
          const prefix = lineIndex === 0 && i === 0 ? OUTPUT_INITIAL_PREFIX : OUTPUT_SUBSEQUENT_PREFIX;
          wrapped.push(`${DIM_ON}${prefix}${physical[i]}${INTENSITY_RESET}`);
        }
      });
      const makeEllipsis = (omitted: number) =>
        `${DIM_ON}${OUTPUT_SUBSEQUENT_PREFIX}… +${omitted} lines (${row.expandHint})${INTENSITY_RESET}`;
      const ellipsisRow = makeEllipsis(0);
      const { lines: kept, omitted } = truncateMiddle(
        wrapped,
        rowCounts,
        OUTPUT_MAX_ROWS,
        0,
        ellipsisRow,
      );
      if (omitted > 0) {
        // Swap the placeholder ellipsis (count 0) for the real count.
        const index = kept.indexOf(ellipsisRow);
        if (index >= 0) kept[index] = makeEllipsis(omitted);
        lines.push(...kept);
      } else {
        lines.push(...kept);
      }
    }
  }
  return lines;
}
