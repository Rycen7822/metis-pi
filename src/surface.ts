// Composer surface painting (OpenCode-style gray prompt surface, Codex-neutral
// hue). One painter, three consumers (editor, composer metadata, and any
// future surface block) so the bg RGB is defined exactly once here.
//
// A stateless "wrap the row in bg…49m" is NOT equivalent (same trap as DIM):
// the host editor emits inner resets — the cursor cell is `\x1b[7m \x1b[0m` —
// and any reset clears our background for the rest of the physical row. The
// painter therefore re-asserts the bg after every bg-clearing SGR inside the
// row, honoring extended-color argument consumption (48;2;R;G;B / 48;5;N).

import { appendAfterSgr } from "./sgr.ts";
import { rgbToAnsi256, type ColorLevel, type Rgb } from "./palette.ts";
import { cellWidth } from "./segments.ts";

/** Dark neutral surface, within the spec's #1f1f1f..#232323 band. */
const COMPOSER_BG: Rgb = { r: 31, g: 31, b: 31 }; // #1f1f1f

function bgAnsi(rgb: Rgb, level: ColorLevel): string {
  if (level.kind === "truecolor") return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  if (level.kind === "ansi256") return `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
  return ""; // ansi16 cannot represent the surface honestly; none = no SGR
}

/** Restore our background only if the final background command cleared it. */
function reassertBackground(segment: string, bg: string): string {
  return appendAfterSgr(segment, (commands) => {
    let cleared = false;
    for (const code of commands) {
      if (code === 0 || code === 49) cleared = true;
      else if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) cleared = false;
    }
    return cleared ? bg : "";
  });
}

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
const CURSOR_MARKER = "\x1b_pi:c\x07";

/** Built by index.ts; the pad-to-width uses our own CJK-aware measurement
 * (pi-tui does not export applyBackgroundToLine from its index). */
export function makeSurfaceOps(
  level: ColorLevel,
  accent: (text: string) => string,
  dim: (text: string) => string,
): SurfaceOps {
  const bg = bgAnsi(COMPOSER_BG, level);
  const bgFn = (text: string): string => (bg ? `${bg}${reassertBackground(text, bg)}\x1b[49m` : text);
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
