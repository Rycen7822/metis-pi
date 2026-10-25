// Single runtime path from structured rows to Codex-styled diff lines (edit and write components).

import { renderDiffLines } from "./diff.ts";
import type { DiffRow } from "../file-changes/diff.ts";
import type { CopyRow } from "../selection-copy/model.ts";
import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { DiffLayoutOps } from "./contracts.ts";
import { DIM_ON, INTENSITY_RESET, type ColorLevel } from "./palette.ts";

const DIFF_PREVIEW_ROWS = 5;

export interface DiffComponentInput {
  readonly rows: readonly DiffRow[];
  readonly filePath: string;
  readonly paint?: (text: string, language: string) => string;
  readonly colorLevel: ColorLevel;
  readonly expanded?: boolean;
}

export function renderCodexDiffComponent(
  input: DiffComponentInput,
  width: number,
  layout: DiffLayoutOps,
  copyOut?: CopyRow[],
): string[] {
  const start = input.expanded ? 0 : Math.max(0, input.rows.findIndex(row => row.kind === "add" || row.kind === "remove"));
  const rows = input.expanded ? input.rows : input.rows.slice(start, start + DIFF_PREVIEW_ROWS);
  const copyStart = copyOut?.length ?? 0;
  const lines = renderDiffLines({
    rows,
    width,
    layout,
    colorLevel: input.colorLevel,
    language: getLanguageFromPath(input.filePath),
    paint: input.paint,
    copyOut,
  });
  if (!input.expanded && (rows.length < input.rows.length || lines.length > DIFF_PREVIEW_ROWS)) {
    const hint = truncateToWidth("  … (click to expand)", Math.max(1, width));
    lines.splice(DIFF_PREVIEW_ROWS, Infinity, input.colorLevel.kind === "none" ? hint : `${DIM_ON}${hint}${INTENSITY_RESET}`);
    copyOut?.splice(copyStart + DIFF_PREVIEW_ROWS, Infinity, { spans: [{ colStart: 0, colEnd: width, kind: "decoration" }], breakBefore: "gap" });
  }
  return lines.length ? lines : [""];
}
