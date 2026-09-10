// Codex diff rendering (openai/codex diff_render.rs): gutter + sign + content,
// full-row background, hanging indent continuation, hunk separators, and the
// truecolor/256/16 degradation chain. The diff payload parsed here is the
// DISPLAY string Pi already produces (EditToolDetails.diff) plus write-tracker
// file changes; tool results are never modified.

import {
  DIFF_ADD_BG, DIFF_DEL_BG, MOCHA,
  backgroundAnsi, foregroundAnsi, DIM_ON, INTENSITY_RESET, BG_RESET,
  type ColorLevel,
} from "./palette.ts";

export { DIM_ON, INTENSITY_RESET, BG_RESET };
export const CODEX_DIFF_DARK_ADD_BG = [DIFF_ADD_BG.r, DIFF_ADD_BG.g, DIFF_ADD_BG.b] as const;
export const CODEX_DIFF_DARK_DEL_BG = [DIFF_DEL_BG.r, DIFF_DEL_BG.g, DIFF_DEL_BG.b] as const;
import type { LayoutOps } from "./shell.ts";

const DIFF_LEFT_INSET = 2;
export { DIFF_LEFT_INSET };

export type DiffRowKind = "add" | "remove" | "context" | "separator" | "metadata";

export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly oldNumber?: number;
  readonly newNumber?: number;
  /** Single-number view for Pi's display diff (old OR new side). */
  readonly lineNumber?: number;
  readonly content: string;
}

export interface DiffStats { added: number; removed: number }

/**
 * Parse Pi's display diff ("- 10 old", "+ 10 new", "  9 ctx", "     ...").
 * Deliberately narrow: arbitrary text is never reinterpreted as a diff.
 * When both old/new numbers are present (write-tracker unified diffs) they
 * are preserved so the gutter matches Codex's dual numbering.
 */
export function parseDisplayDiff(diffText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of diffText.split("\n")) {
    if (/^\s*\.\.\.\s*$/.test(raw)) {
      rows.push({ kind: "separator", content: "…" });
      continue;
    }
    const match = raw.match(/^([+\- ])\s*(\d*)(?:\s+(\d*))?\s(.*)$/);
    if (match) {
      const sign = match[1]!;
      const first = match[2]!.trim();
      const second = match[3] !== undefined ? match[3].trim() : undefined;
      const content = match[4]!.replace(/\t/g, "    ");
      const kind: DiffRowKind = sign === "+" ? "add" : sign === "-" ? "remove" : "context";
      if (second !== undefined && second !== "") {
        rows.push({ kind, oldNumber: Number(first), newNumber: Number(second), lineNumber: Number(second), content });
      } else if (first) {
        const number = Number(first);
        rows.push({ kind, oldNumber: kind === "remove" ? number : undefined, newNumber: kind === "remove" ? undefined : number, lineNumber: number, content });
      } else {
        rows.push({ kind, content });
      }
      continue;
    }
    if (raw.length) rows.push({ kind: "metadata", content: raw.replace(/\t/g, "    ") });
  }
  return rows;
}

export function diffStatsFromRows(rows: readonly DiffRow[]): DiffStats {
  return {
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "remove").length,
  };
}

/** Codex line_number_width: width of the widest number, min 1. */
export function lineNumberWidth(max: number): number {
  return max === 0 ? 1 : String(max).length;
}

export interface DiffRenderInput {
  readonly rows: readonly DiffRow[];
  readonly width: number;
  readonly layout: LayoutOps;
  readonly colorLevel: ColorLevel;
  /** Extension → language for body highlighting (Pi grammar). */
  readonly language?: string;
  readonly paint?: (text: string, language: string) => string;
  readonly expanded: boolean;
  readonly expandHint: string;
}

interface SurfaceStyle {
  readonly lineBg: string;
  readonly signFg: string;
  readonly contentFg: (text: string) => string;
}

/**
 * Codex style_add/style_del: ANSI-16 keeps foreground-only green/red;
 * truecolor/256 tint the full row. Content keeps its own foreground over the
 * background (only SGR color + intensity are used so the background survives).
 */
function surface(kind: "add" | "remove" | "context", level: ColorLevel): SurfaceStyle {
  if (kind === "context") {
    return { lineBg: "", signFg: "", contentFg: (text) => text };
  }
  const rgb = kind === "add" ? DIFF_ADD_BG : DIFF_DEL_BG;
  const bg = backgroundAnsi(rgb, level);
  if (level.kind === "ansi16" || !bg) {
    const fg = kind === "add" ? "\x1b[32m" : "\x1b[31m";
    return { lineBg: "", signFg: fg, contentFg: (text) => `${fg}${text}\x1b[39m` };
  }
  const fg = kind === "add" ? "\x1b[32m" : "\x1b[31m";
  return {
    lineBg: bg,
    signFg: `${fg}${bg}`,
    contentFg: (text) => `${fg}${text}\x1b[39m`,
  };
}

/**
 * Highlight diff body text with the Pi grammar, then rebuild the styled
 * string so the diff background (set per line) is never cleared: only
 * foreground resets are allowed inside content.
 */
function highlightBody(text: string, language: string | undefined, paint: ((text: string, language: string) => string) | undefined, fallback: (text: string) => string): string {
  if (!text) return "";
  if (language && paint) {
    try {
      const painted = paint(text, language);
      if (typeof painted === "string") {
        // Pi's highlighter returns per-line strings containing ANSI colors.
        // Strip any background resets that would clear the diff surface and
        // any background colors it may emit.
        return painted.replace(/\x1b\[4[89][^m]*m/g, "").replace(/\x1b\[10[0-7]m/g, "");
      }
    } catch { /* Syntax coloring is optional. */ }
  }
  return fallback(text);
}

/** Render diff rows Codex-style. */
export function renderDiffLines(input: DiffRenderInput): string[] {
  const { rows, layout, colorLevel } = input;
  const usable = Math.max(1, Math.floor(input.width));
  const out: string[] = [];

  const maxNew = Math.max(0, ...rows.map((row) => row.newNumber ?? 0));
  const maxOld = Math.max(0, ...rows.map((row) => row.oldNumber ?? 0));
  const numberWidth = lineNumberWidth(Math.max(maxNew, maxOld));
  // Codex prefix: gutter(number + space) + sign char. Content hangs at
  // prefix+1 columns on continuation rows.
  const prefixCols = 2 + numberWidth + 1 + 1; // left inset + number + space + sign
  const contentWidth = Math.max(1, usable - prefixCols);

  let previousKind: DiffRowKind | undefined;
  for (const row of rows) {
    if (row.kind === "separator") {
      out.push(`${" ".repeat(prefixCols - 1)}…`);
      previousKind = row.kind;
      continue;
    }
    if (row.kind === "metadata") {
      for (const chunk of layout.wrap(row.content, Math.max(1, usable - 2))) {
        out.push(`  ${chunk}`);
      }
      previousKind = row.kind;
      continue;
    }
    // Hunk separators: Codex renders "⋮" between hunks. The Pi display diff
    // carries no hunk boundaries; write-tracker diffs mark them explicitly
    // via a metadata row of "⋮". (See file-change.ts.)
    void previousKind;

    const style = surface(row.kind, colorLevel);
    const numberText = row.newNumber !== undefined
      ? String(row.newNumber)
      : row.oldNumber !== undefined ? String(row.oldNumber) : "";
    const gutter = `${" ".repeat(2)}${numberText.padStart(numberWidth)} `;
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const signStyled = row.kind === "context" ? sign : `\x1b[${style.signFg}${sign}\x1b[39m${style.lineBg}`;
    void signStyled;

    let content = highlightBody(
      row.content,
      row.kind === "remove" ? undefined : input.language,
      input.paint,
      (text) => style.contentFg(text),
    );
    if (row.kind === "remove") {
      // Codex dims delete-line syntax so the removal cue wins.
      content = `${DIM_ON}${content}${INTENSITY_RESET}`;
    }
    const chunks = layout.wrap(content, contentWidth);
    const physical = chunks.length ? chunks : [""];
    for (let i = 0; i < physical.length; i++) {
      const head = i === 0
        ? `${gutter}${style.signFg}${sign}\x1b[39m`
        : `${" ".repeat(2)}${" ".repeat(numberWidth)}  `;
      const line = style.lineBg
        ? `${style.lineBg}${head}${physical[i]}${BG_RESET}`
        : `${head}${physical[i]}`.trimEnd();
      out.push(style.lineBg ? padToWidth(line, usable, layout) : line);
    }
  }
  return out;
}

function padToWidth(line: string, width: number, layout: LayoutOps): string {
  const visible = layout.visibleWidth(line);
  return visible >= width ? line : `${line}${" ".repeat(width - visible)}`;
}

/** Summarize rows for the header: "(+A -D)". */
export function renderCountSummary(stats: DiffStats): (painter: (text: string, color: "add" | "remove" | "plain") => string) => string {
  return (painter) => `(${painter(`+${stats.added}`, "add")} ${painter(`-${stats.removed}`, "remove")})`;
}

export { MOCHA };
