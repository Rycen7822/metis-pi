// Composer surface painting (OpenCode-style gray prompt surface, Codex-neutral
// hue). One painter, three consumers (editor, composer metadata, and any
// future surface block) so the bg RGB is defined exactly once here.
//
// A stateless "wrap the row in bg…49m" is NOT equivalent (same trap as DIM):
// the host editor emits inner resets — the cursor cell is `\x1b[7m \x1b[0m` —
// and any reset clears our background for the rest of the physical row. The
// painter therefore re-asserts the bg after every bg-clearing SGR inside the
// row, honoring extended-color argument consumption (48;2;R;G;B / 48;5;N).

import { rgbToAnsi256, type ColorLevel, type Rgb } from "./palette.ts";
import { cellWidth } from "./segments.ts";

/** Dark neutral surface, within the spec's #1f1f1f..#232323 band. */
export const COMPOSER_BG: Rgb = { r: 31, g: 31, b: 31 }; // #1f1f1f

function bgAnsi(rgb: Rgb, level: ColorLevel): string {
  if (level.kind === "truecolor") return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  if (level.kind === "ansi256") return `\x1b[48;5;${rgbToAnsi256(rgb)}m`;
  return ""; // ansi16 cannot represent the surface honestly; none = no SGR
}

/** Re-emit `bg` after every SGR that cleared the background inside `segment`.
 * Extended-color prefixes (38/48/58) consume their arguments so component
 * values like 0/49/2 can never read as resets. */
function reassertBackground(segment: string, bg: string): string {
  if (!segment.includes("\x1b")) return segment;
  let out = "";
  let index = 0;
  while (index < segment.length) {
    const char = segment[index]!;
    if (char === "\x1b" && segment[index + 1] === "[") {
      const match = /^\x1b\[([0-9;:]*)([a-zA-Z])/.exec(segment.slice(index));
      if (match && match[2] === "m") {
        const raw = match[1] ?? "";
        const colon = raw.includes(":");
        const parts = raw === "" ? [] : raw.split(";");
        const hasEmpty = raw === "" || parts.some((p) => p === "");
        const numeric = parts.map((p) => Number.parseInt(p, 10)).filter(Number.isFinite) as number[];
        let clearsBg = hasEmpty && !colon;
        let setsBg = false;
        for (let i = 0; i < numeric.length && !clearsBg; i++) {
          const p = numeric[i]!;
          if (p === 38 || p === 48 || p === 58) {
            const mode = numeric[i + 1];
            if (mode === 2) i += 5;
            else if (mode === 5) i += 3;
            else i += 1;
            if (p === 48) setsBg = true;
          } else if (p === 0) {
            clearsBg = true;
          } else if (p === 49) {
            clearsBg = true;
          }
        }
        out += match[0];
        if (clearsBg && !setsBg) out += bg;
        index += match[0].length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
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

/** True when the level can carry the surface at all. */
export function surfaceSupported(kind: ColorLevel["kind"]): boolean {
  return kind === "truecolor" || kind === "ansi256";
}
