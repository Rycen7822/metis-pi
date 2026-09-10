// thinking-rail.ts — a narrow static rail to the left of a thinking run.
//
// OpenCode-style left rail, terminal-native: one ▏ (ASCII fallback |) + one
// space, drawn BEFORE every physical line the wrapped child renders. The
// child keeps its own Markdown styling, MouseRegion click semantics and
// invalidation; the rail is purely a prefix on its render output plus a
// matching x-offset for mouse coordinates.

import type { ColorLevel } from "./palette.ts";
import { foregroundAnsi } from "./palette.ts";

/** Rail glyph + trailing space (2 cells), or plain "|" in no-color mode. */
export function railGlyph(colorLevel: ColorLevel): { text: string; cells: number } {
  const glyph = colorLevel.kind === "none" ? "|" : "▏";
  const text = colorLevel.kind === "none" ? `${glyph} ` : `${foregroundAnsi("#94e2d5", colorLevel)}${glyph}\x1b[39m `;
  return { text, cells: 2 };
}

/** Recolor the glyph for the current line without re-trimming the layout. */
function railPrefix(glyph: { text: string; cells: number }, colorLevel: ColorLevel): string {
  if (colorLevel.kind === "none") return glyph.text;
  return `${foregroundAnsi("#94e2d5", colorLevel)}▏\x1b[39m `;
}

export interface RailComponent {
  render(width: number): string[];
  handleMouse?(event: unknown): unknown;
  invalidate?(): void;
}

/**
 * Wrap a thinking display node. Same physical line count (the host's own
 * Markdown keeps wrapping), each line gains a 2-cell rail prefix; mouse x is
 * shifted by the rail width so hit-testing stays aligned. Non-mouse events
 * pass through untouched.
 */
export function createThinkingRail(child: RailComponent, colorLevel: ColorLevel): RailComponent {
  const glyph = railGlyph(colorLevel);
  let cacheWidth = -1;
  let cache: string[] | undefined;
  const isRailLine = (line: string): boolean => {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    return stripped.startsWith("▏") || stripped.startsWith("| ");
  };
  return {
    render(width: number): string[] {
      if (cache && cacheWidth === width) return cache;
      const innerWidth = Math.max(1, width - glyph.cells);
      const childLines = child.render(innerWidth);
      // The rail owns its own prefix; never double-prefix a re-wrapped node.
      cache = childLines.map((line) => (isRailLine(line) ? line : `${railPrefix(glyph, colorLevel)}${line}`));
      cacheWidth = width;
      return cache;
    },
    handleMouse(event: unknown): unknown {
      const e = (event ?? {}) as { type?: string; x?: number; y?: number; button?: string; width?: number; height?: number };
      if (e.type === "click" && e.button === "left" && typeof e.x === "number") {
        // Clicks on the rail column itself do NOT toggle; pass through only
        // events inside the child's area.
        if (e.x < glyph.cells) return undefined;
        const shifted = { ...e, x: e.x - glyph.cells, width: (e.width ?? 0) - glyph.cells };
        return child.handleMouse?.(shifted);
      }
      return child.handleMouse?.(event);
    },
    invalidate() {
      cache = undefined;
      cacheWidth = -1;
      child.invalidate?.();
    },
  };
}
