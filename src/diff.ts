// The one Codex-style diff renderer (structured DiffRow[] → gutter + sign +
// content rows, full-row background, degradation chain); rows come from
// write-tracker or parseDisplayDiff. Display-only.

import {
  DIFF_ADD_BG, DIFF_DEL_BG, MOCHA,
  backgroundAnsi, DIM_ON, INTENSITY_RESET, BG_RESET,
  type ColorLevel,
} from "./palette.ts";

export { DIM_ON, INTENSITY_RESET, BG_RESET };
export const CODEX_DIFF_DARK_ADD_BG = [DIFF_ADD_BG.r, DIFF_ADD_BG.g, DIFF_ADD_BG.b] as const;
export const CODEX_DIFF_DARK_DEL_BG = [DIFF_DEL_BG.r, DIFF_DEL_BG.g, DIFF_DEL_BG.b] as const;
import type { LayoutOps } from "./shell.ts";
import type { CopyRow } from "./selection-copy/model.ts";

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
 * Parse Pi's display diff: exactly `sign` + optional single line number + one
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
      if (raw[index] === " " && /[0-9]/.test(raw[index + 1] ?? "")) index += 1;
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
      if (!digits && index < raw.length && raw[index] === " ") {
        // No line number: the first space was the separator.
        const content = raw.slice(index + 1).replace(/\t/g, "    ");
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
  readonly expanded: boolean;
  readonly expandHint: string;
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

function surface(kind: "add" | "remove" | "context", level: ColorLevel): SurfaceStyle {
  if (kind === "context" || level.kind === "none") {
    return { lineBg: "", signFg: "", contentFg: (text) => text };
  }
  const rgb = kind === "add" ? DIFF_ADD_BG : DIFF_DEL_BG;
  const bg = backgroundAnsi(rgb, level);
  const fg = kind === "add" ? "\x1b[32m" : "\x1b[31m";
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
function highlightBody(text: string, language: string | undefined, paint: ((text: string, language: string) => string) | undefined, fallback: (text: string) => string): string {
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
 * walks visible characters by display width; escape sequences ride along
 * without width, never split mid-sequence, and stay active across the wrap so
 * continuation rows keep the same style. A physical row never contains a
 * partial escape sequence.
 */
export function wrapStyledContent(text: string, width: number): string[] {
  const widthOf = (char: string): number => {
    const code = char.codePointAt(0)!;
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f64f)
      || (code >= 0x1f900 && code <= 0x1f9ff)
      || (code >= 0x20000 && code <= 0x3fffd))) return 2;
    return 1;
  };
  const lines: string[] = [];
  let current = "";
  let cells = 0;
  let index = 0;
  // Style sequences seen since the last visible character; re-emitted at the
  // start of a continuation row so the style state carries across the wrap.
  let trailingStyles = "";
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\x1b") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        current += match[0];
        trailingStyles += match[0];
        index += match[0].length;
        continue;
      }
    }
    const w = widthOf(char);
    if (cells + w > width && cells > 0) {
      lines.push(current);
      current = trailingStyles;
      cells = 0;
    }
    current += char;
    cells += w;
    trailingStyles = "";
    index += 1;
  }
  lines.push(current);
  // Drop a trailing row that is pure styling (nothing visible).
  if (lines.length > 1 && lines.at(-1)!.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") === "" && text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") !== "") {
    lines.pop();
  }
  return lines.length ? lines : [""];
}

/** Render diff rows Codex-style from structured rows. Never returns empty. */
function stripAnsiDiff(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function renderDiffLines(input: DiffRenderInput): string[] {
  const { rows, layout, colorLevel } = input;
  const usable = Math.max(1, Math.floor(input.width));
  if (!rows.length) return [];

  const maxNew = Math.max(0, ...rows.map((row) => row.newNumber ?? 0));
  const maxOld = Math.max(0, ...rows.map((row) => row.oldNumber ?? 0));
  const numberWidth = lineNumberWidth(Math.max(maxNew, maxOld));
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
    const physical = chunks.length ? chunks : [""];

    for (let i = 0; i < physical.length; i++) {
      const head = i === 0
        ? `${gutter}${style.signFg ? `${style.signFg}${sign}\x1b[39m` : sign}`
        : `${" ".repeat(DIFF_LEFT_INSET)}${" ".repeat(numberWidth)}  `;
      const body = physical[i]!;
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
            { colStart: prefixCols, colEnd: prefixCols + layout.visibleWidth(body), kind: "content", text: stripAnsiDiff(body) },
          ],
          breakBefore: "hard",
        });
      } else {
        input.copyOut?.push({
          spans: [
            { colStart: 0, colEnd: prefixCols, kind: "decoration" },
            { colStart: prefixCols, colEnd: prefixCols + layout.visibleWidth(body), kind: "content", text: stripAnsiDiff(body) },
          ],
          breakBefore: "soft",
        });
      }
    }
  }
  return out.length ? out : [""];
}

/** Summarize rows for the header: "(+A -D)". */
export function renderCountSummary(stats: DiffStats): (painter: (text: string, color: "add" | "remove" | "plain") => string) => string {
  return (painter) => `(${painter(`+${stats.added}`, "add")} ${painter(`-${stats.removed}`, "remove")})`;
}

export { MOCHA };
