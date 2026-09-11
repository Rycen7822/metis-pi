// Single runtime path from structured rows to Codex-styled diff lines (edit and write components).

import { renderDiffLines, type DiffRow } from "./diff.ts";
import { languageForPath } from "./renderers.ts";
import type { DiffLayoutOps } from "./tool-names.ts";
import type { ColorLevel } from "./palette.ts";

export interface DiffComponentInput {
  readonly rows: readonly DiffRow[];
  readonly filePath: string;
  readonly paint?: (text: string, language: string) => string;
  readonly colorLevel: ColorLevel;
  readonly expanded: boolean;
  readonly expandHint: string;
}

/** Render rows at a concrete terminal width (layout ops from the live host). */
export function renderCodexDiffComponent(
  input: DiffComponentInput,
  width: number,
  layout: DiffLayoutOps,
): string[] {
  const lines = renderDiffLines({
    rows: input.rows,
    width,
    layout,
    colorLevel: input.colorLevel,
    language: languageForPath(input.filePath),
    paint: input.paint,
    expanded: input.expanded,
    expandHint: input.expandHint,
  });
  return lines.length ? lines : [""];
}
