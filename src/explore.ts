// Codex "• Explored" exploration rows (exec_cell/render.rs exploring_display_lines).
// A group header is owned by the FIRST member's component; later members render
// with a four-space gutter. Display-only.

import { foregroundAnsi, type ColorLevel } from "./palette.ts";

const EXPLORATION_BLUE = "#89b4fa"; // Mocha blue for member verbs
const DIM_GRAY = "#6c7086"; // Mocha overlay0 for the " in " hint

export type ExplorationVerb = "Read" | "Search" | "Find" | "List" | "Run";

export interface ExplorationRow {
  readonly verb: ExplorationVerb;
  readonly target: string;
  /** Optional path shown after a dim " in " (Search rows). */
  readonly inPath?: string;
}

export interface ExplorationRender {
  readonly running: boolean;
  readonly isError: boolean;
  readonly rows: readonly ExplorationRow[];
}

const VERBS = { read: "Read", grep: "Search", find: "Find", ls: "List" } as const;

export function explorationVerb(name: string): ExplorationVerb {
  return VERBS[name as keyof typeof VERBS] ?? "Read";
}

/** "• Explored|Exploring" group title line. */
export function renderExplorationHeader(render: { running: boolean; isError: boolean }, colorLevel: ColorLevel, theme: { bold(text: string): string }): string {
  const dim = foregroundAnsi(DIM_GRAY, colorLevel);
  const title = render.isError ? "Exploration failed" : render.running ? "Exploring" : "Explored";
  return `${dim}•\x1b[39m ${theme.bold(title)}`;
}

/** One member row: "  └ " (first) or "    " (later) + cyan verb + target. */
export function renderExplorationMember(row: ExplorationRow, options: { first: boolean; isError?: boolean }, colorLevel: ColorLevel): string {
  const blue = foregroundAnsi(EXPLORATION_BLUE, colorLevel);
  const dim = foregroundAnsi(DIM_GRAY, colorLevel);
  const gutter = options.first ? "  └ " : "    ";
  const head = `${blue}${row.verb}\x1b[39m `;
  const body = row.inPath !== undefined
    ? `${row.target} ${dim}in\x1b[39m ${row.inPath}`
    : row.target;
  return `${dim}${gutter}\x1b[39m${head}${body}`;
}

/** Aggregated image notice: counted from real image blocks, shown once. */
export function renderExplorationImages(count: number, colorLevel: ColorLevel, showImages: boolean | undefined): string | undefined {
  if (!count) return undefined;
  const dim = foregroundAnsi(DIM_GRAY, colorLevel);
  const suffix = showImages === false ? " (TUI previews disabled)" : "";
  return `${dim}    ${count} image${count === 1 ? "" : "s"}${suffix}\x1b[39m`;
}

/** All-in-one render for ungrouped calls: header + own rows. */
export function renderExplorationLines(render: ExplorationRender, colorLevel: ColorLevel, theme: { bold(text: string): string }): string[] {
  const lines = [renderExplorationHeader(render, colorLevel, theme)];
  for (const row of render.rows) {
    lines.push(renderExplorationMember(row, { first: true }, colorLevel));
  }
  return lines;
}
