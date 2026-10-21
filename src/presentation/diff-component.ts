// Single runtime path from structured rows to Codex-styled diff lines (edit and write components).

import { renderDiffLines } from "./diff.ts";
import type { DiffRow } from "../file-changes/diff.ts";
import type { CopyRow } from "../selection-copy/model.ts";
import { languageForPath } from "./tool-names.ts";
import type { DiffLayoutOps } from "./contracts.ts";
import type { ColorLevel } from "./palette.ts";

export interface DiffComponentInput {
  readonly rows: readonly DiffRow[];
  readonly filePath: string;
  readonly paint?: (text: string, language: string) => string;
  readonly colorLevel: ColorLevel;
}

export function renderCodexDiffComponent(
  input: DiffComponentInput,
  width: number,
  layout: DiffLayoutOps,
  copyOut?: CopyRow[],
): string[] {
  const lines = renderDiffLines({
    rows: input.rows,
    width,
    layout,
    colorLevel: input.colorLevel,
    language: languageForPath(input.filePath),
    paint: input.paint,
    copyOut,
  });
  return lines.length ? lines : [""];
}
