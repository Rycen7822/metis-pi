// The one Codex-style diff renderer (structured DiffRow[] → gutter + sign +
// content rows, full-row background, degradation chain); rows come from
// write-tracker or parseDisplayDiff. Display-only.

import {
  DIFF_ADD_BG, DIFF_DEL_BG,
  backgroundAnsi, DIM_ON, INTENSITY_RESET, BG_RESET,
  type ColorLevel,
} from "./palette.ts";

import type { LayoutOps } from "./shell.ts";
import type { CopyRow } from "../selection-copy/model.ts";
import { AnsiTracker, styledParts, stripAnsi } from "../selection-copy/wrap.ts";
import { cellWidth } from "./segments.ts";

export const DIFF_LEFT_INSET = 2;

import type { DiffRow, DiffRowKind, DiffStats } from "../file-changes/diff.ts";

/**
 * Parse Pi's display diff: exactly `sign` + optional space-padded line number + one
 * separator space + content VERBATIM. Content-initial digits and leading
 * indentation are never reinterpreted:
 *   "+ 10 123 value"  => number=10, content="123 value"
 *   "+ 10   return x" => number=10, content="  return x"
 */
export function parseDisplayDiff(diffText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const raw of diffText.split("\n")) {
    if (/^\s*(\.\.\.|⋮)\s*$/.test(raw)) {
      rows.push({ kind: "separator", content: "…" });
      continue;
    }
    const sign = raw[0];
    if (sign === "+" || sign === "-" || sign === " ") {
      let index = 1;
      while (raw[index] === " ") index += 1;
      let digits = "";
      while (index < raw.length && raw[index]! >= "0" && raw[index]! <= "9") {
        digits += raw[index]!;
        index += 1;
      }
      if (digits && index < raw.length && raw[index] === " ") {
        const content = raw.slice(index + 1).replace(/\t/g, "    ");
        const kind: DiffRowKind = sign === "+" ? "add" : sign === "-" ? "remove" : "context";
        const number = Number(digits);
        rows.push({
          kind,
          oldNumber: kind === "remove" ? number : undefined,
          newNumber: kind === "remove" ? undefined : number,
          lineNumber: number,
          content,
        });
        continue;
      }
      if (!digits && raw[1] === " ") {
        // No line number: only the first space was the separator; the rest
        // belongs to the content, not a padded gutter.
        const content = raw.slice(2).replace(/\t/g, "    ");
        const kind: DiffRowKind = sign === "+" ? "add" : sign === "-" ? "remove" : "context";
        rows.push({ kind, content });
        continue;
      }
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
  /** Selection-copy provenance: one CopyRow per emitted visual row. */
  readonly copyOut?: CopyRow[];
}

/**
 * Codex style_add/style_del: dark themes tint the full row and add a green/red
 * foreground; ANSI-16 keeps foreground-only cues; "none" emits no SGR at all.
 */
interface SurfaceStyle {
  readonly lineBg: string;
  readonly signFg: string;
  readonly contentFg: (text: string) => string;
}

/** Foreground-only green/red of the diff signs (`\x1b[32m` / `\x1b[31m`, Codex
 * style); "" when colour is off. The footer's +A/−D tones reuse this, so the two
 * readouts cannot drift apart. */
export function diffSignFg(kind: "add" | "remove", level: ColorLevel): string {
  if (level.kind === "none") return "";
  return kind === "add" ? "\x1b[32m" : "\x1b[31m";
}

function surface(kind: "add" | "remove" | "context", level: ColorLevel): SurfaceStyle {
  if (kind === "context") {
    return { lineBg: "", signFg: "", contentFg: (text) => text };
  }
  const fg = diffSignFg(kind, level);
  if (!fg) {
    return { lineBg: "", signFg: "", contentFg: (text) => text };
  }
  const rgb = kind === "add" ? DIFF_ADD_BG : DIFF_DEL_BG;
  const bg = backgroundAnsi(rgb, level);
  if (!bg) {
    // ANSI-16: foreground-only cue (Codex behavior).
    return { lineBg: "", signFg: fg, contentFg: (text) => `${fg}${text}\x1b[39m` };
  }
  return {
    lineBg: bg,
    signFg: `${fg}${bg}`,
    contentFg: (text) => `${fg}${text}\x1b[39m`,
  };
}

/**
 * Highlight diff body with the Pi grammar, then rebuild the styled string so
 * the diff background survives: drop any background SGR the highlighter emits
 * and translate bare full resets into foreground-only resets.
 */
function highlightBody(
  text: string,
  language: string | undefined,
  paint: ((text: string, language: string) => string) | undefined,
  fallback: (text: string) => string,
): string {
  if (!text) return "";
  if (language && paint) {
    try {
      const painted = paint(text, language);
      if (typeof painted === "string") {
        return painted
          // Background colors/resets would punch holes in the row surface.
          .replace(/\x1b\[4[89][^m]*m/g, "")
          .replace(/\x1b\[10[0-7]m/g, "")
          // Full resets (0m) become foreground resets so the bg survives.
          .replace(/\x1b\[0m/g, "\x1b[39m")
          // Default-background resets are no-ops for us once bg is dropped.
          .replace(/\x1b\[49m/g, "");
      }
    } catch { /* Syntax coloring is optional. */ }
  }
  return fallback(text);
}

/**
 * ANSI-aware hard wrap for diff content (Codex wrap_styled_spans equivalent):
 * Pi owns grapheme widths; the shared ANSI tracker preserves continuation
 * styling. Diff keeps source spaces rather than using prose word-wrap rules.
 */
export function wrapStyledContent(text: string, width: number): string[] {
  const usable = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  const tracker = new AnsiTracker();
  let line = "";
  let cells = 0;
  for (const part of styledParts(text)) {
    if (part.ansi !== undefined) {
      line += part.ansi;
      tracker.process(part.ansi);
      continue;
    }
    const grapheme = part.grapheme!;
    const width = cellWidth(grapheme);
    if (cells > 0 && cells + width > usable) {
      lines.push(line + tracker.getLineEndReset());
      line = tracker.getActiveCodes();
      cells = 0;
    }
    line += grapheme;
    cells += width;
  }
  lines.push(line);
  return lines;
}

/** Render diff rows Codex-style from structured rows. Never returns empty. */

export function renderDiffLines(input: DiffRenderInput): string[] {
  const { rows, layout, colorLevel } = input;
  const usable = Math.max(1, Math.floor(input.width));
  if (!rows.length) return [];

  const maxNew = Math.max(0, ...rows.map((row) => row.newNumber ?? 0));
  const maxOld = Math.max(0, ...rows.map((row) => row.oldNumber ?? 0));
  const maxSingle = Math.max(0, ...rows.map((row) => row.lineNumber ?? 0));
  const numberWidth = lineNumberWidth(Math.max(maxNew, maxOld, maxSingle));
  // Codex prefix: left inset + gutter(number + space) + sign char.
  const prefixCols = DIFF_LEFT_INSET + numberWidth + 1 + 1;
  const contentWidth = Math.max(1, usable - prefixCols);
  const out: string[] = [];

  for (const row of rows) {
    if (row.kind === "separator") {
      const line = `${" ".repeat(prefixCols - 1)}…`;
      out.push(line);
      input.copyOut?.push({
        spans: [{ colStart: 0, colEnd: usable, kind: "semantic", text: "…" }],
        breakBefore: "gap",
      });
      continue;
    }
    if (row.kind === "metadata") {
      for (const chunk of layout.wrap(row.content, Math.max(1, usable - DIFF_LEFT_INSET))) {
        out.push(`${" ".repeat(DIFF_LEFT_INSET)}${chunk}`);
        input.copyOut?.push({
          spans: [
            { colStart: 0, colEnd: DIFF_LEFT_INSET, kind: "decoration" },
            { colStart: DIFF_LEFT_INSET, colEnd: DIFF_LEFT_INSET + layout.visibleWidth(chunk), kind: "content", text: chunk },
          ],
          breakBefore: "hard",
        });
      }
      continue;
    }

    const style = surface(row.kind, colorLevel);
    const numberText = row.lineNumber !== undefined
      ? String(row.lineNumber)
      : row.newNumber !== undefined
        ? String(row.newNumber)
        : row.oldNumber !== undefined ? String(row.oldNumber) : "";
    const sign = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
    const gutter = `${" ".repeat(DIFF_LEFT_INSET)}${numberText.padStart(numberWidth)} `;

    // Highlight the whole row once, then ANSI-aware wrap (never a naive slice
    // mid-sequence). Delete rows keep syntax colors under an overlay dim.
    let content = highlightBody(
      row.content,
      input.language,
      input.paint,
      (text) => style.contentFg(text),
    );
    if (row.kind === "remove" && content) {
      // Codex dims delete-line syntax so the removal cue wins (overlay dim,
      // never dropping the language colors).
      content = `${DIM_ON}${content}${INTENSITY_RESET}`;
    }
    const chunks = wrapStyledContent(content, contentWidth);

    for (let i = 0; i < chunks.length; i++) {
      const head = i === 0
        ? `${gutter}${style.signFg ? `${style.signFg}${sign}\x1b[39m` : sign}`
        : `${" ".repeat(DIFF_LEFT_INSET)}${" ".repeat(numberWidth)}  `;
      const body = chunks[i]!;
      if (style.lineBg) {
        // Padding BEFORE the background reset: the surface reaches the right
        // edge (Codex line-level bg). Layout: bg on, gutter+sign, content,
        // pad, bg off.
        const visible = layout.visibleWidth(head + body);
        const pad = " ".repeat(Math.max(0, usable - visible));
        out.push(`${style.lineBg}${head}${body}${pad}${BG_RESET}`);
      } else {
        out.push(`${head}${body}`.trimEnd());
      }
      const signCell = DIFF_LEFT_INSET + numberWidth + 1;
      if (i === 0) {
        input.copyOut?.push({
          spans: [
            { colStart: 0, colEnd: signCell, kind: "decoration" },
            { colStart: signCell, colEnd: signCell + 1, kind: "semantic", text: sign === " " ? undefined : sign },
            { colStart: prefixCols, colEnd: prefixCols + layout.visibleWidth(body), kind: "content", text: stripAnsi(body) },
          ],
          breakBefore: "hard",
        });
      } else {
        input.copyOut?.push({
          spans: [
            { colStart: 0, colEnd: prefixCols, kind: "decoration" },
            { colStart: prefixCols, colEnd: prefixCols + layout.visibleWidth(body), kind: "content", text: stripAnsi(body) },
          ],
          breakBefore: "soft",
        });
      }
    }
  }
  return out.length ? out : [""];
}
