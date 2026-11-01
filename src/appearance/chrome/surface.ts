// Composer surface painting (OpenCode-style gray prompt surface, Codex-neutral
// hue). The dark fill and reset-safe background painter are shared with popups.
//
// A stateless "wrap the row in bg…49m" is NOT equivalent (same trap as DIM):
// the host editor emits inner resets — the cursor cell is `\x1b[7m \x1b[0m` —
// and any reset clears our background for the rest of the physical row. The
// painter therefore re-asserts the bg after every bg-clearing SGR inside the
// row, honoring extended-color argument consumption (48;2;R;G;B / 48;5;N).

import { paintSurfaceBackground } from "../../presentation/sgr.ts";
import { backgroundAnsi, DARK_SURFACE_BG, type ColorLevel } from "../../presentation/palette.ts";
import { cellWidth } from "../../presentation/segments.ts";

export interface SurfaceOps {
  /** Color level the painter was built for (callers gate features on kind). */
  readonly kind: ColorLevel["kind"];
  /** Paint one physical row: pad to `width` cells, apply the surface bg to
   * content + padding + right fill, re-assert bg after inner resets. The
   * caller owns padding semantics; no-op (bg-less) for ansi16/none levels. */
  paintRow: (row: string, width: number) => string;
  /** Paint a small glyph (prompt prefix, scroll indicator) in a tone. */
  paintGlyph: (text: string, tone: "accent" | "dim") => string;
}

/** Host marker that is zero-width on screen but occupies string length. */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Built by index.ts; the pad-to-width uses our own CJK-aware measurement
 * (pi-tui does not export applyBackgroundToLine from its index). */
export function makeSurfaceOps(
  level: ColorLevel,
  accent: (text: string) => string,
  dim: (text: string) => string,
): SurfaceOps {
  const bg = backgroundAnsi(DARK_SURFACE_BG, level);
  const bgFn = (text: string): string => paintSurfaceBackground(text, bg);
  return {
    kind: level.kind,
    paintRow: (row, width) => {
      if (!bg) return row;
      const w = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 1;
      const visible = cellWidth(row.replaceAll(CURSOR_MARKER, ""));
      const padding = Math.max(0, w - visible);
      return bgFn(`${row}${" ".repeat(padding)}`);
    },
    paintGlyph: (text, tone) => (tone === "accent" ? accent(text) : dim(text)),
  };
}
