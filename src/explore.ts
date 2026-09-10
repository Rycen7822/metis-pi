// Codex exploration rows (exec_cell/render.rs exploring_display_lines):
// "• Explored" header, "  └ " gutter, cyan title, dim " in " between the
// query and the path. Display-only.

import { foregroundAnsi, type ColorLevel } from "./palette.ts";

const EXPLORATION_CYAN = "#94e2d5"; // Mocha teal, Codex's cyan for titles
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

export function renderExplorationLines(render: ExplorationRender, colorLevel: ColorLevel, theme: { bold(text: string): string }): string[] {
  const cyan = foregroundAnsi(EXPLORATION_CYAN, colorLevel);
  const dim = foregroundAnsi(DIM_GRAY, colorLevel);
  const marker = render.isError ? `${dim}•` : render.running ? `${dim}•` : `${dim}•`;
  const title = render.isError ? "Exploration failed" : render.running ? "Exploring" : "Explored";
  const lines = [`${marker} ${theme.bold(title)}`];
  for (const row of render.rows) {
    const head = `${cyan}${row.verb}\x1b[39m `;
    const body = row.inPath !== undefined
      ? `${row.target} ${dim}in\x1b[39m ${row.inPath}`
      : row.target;
    lines.push(`${dim}  └ \x1b[39m${head}${body}`);
  }
  return lines;
}
