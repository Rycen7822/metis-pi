// Live display-only preview of the write args the model is still generating:
// never writes to disk, never executes, never parses unfinished JSON (the host
// hands already-parsed args), never mutates the args.

import type { Palette } from "./tool-names.ts";
import type { ColorLevel } from "./palette.ts";
import type { DiffLayoutOps } from "./tool-names.ts";

/** Write call stage, resolved from host context fields (not just isPartial). */
export type WriteStage =
  | "receiving-arguments"  // streaming args; content may be partially present
  | "arguments-ready"      // argsComplete=true, execution not started
  | "executing"            // markExecutionStarted happened
  | "succeeded"            // final result present and not an error
  | "failed-or-aborted";   // error/aborted result

export interface WriteStageContext {
  argsComplete?: boolean;
  executionStarted?: boolean;
  isPartial?: boolean;
  isError?: boolean;
  hasResult?: boolean;
  aborted?: boolean;
}

export function resolveWriteStage(context: WriteStageContext): WriteStage {
  if (context.hasResult) return context.isError || context.aborted ? "failed-or-aborted" : "succeeded";
  if (context.executionStarted) return "executing";
  if (context.argsComplete) return "arguments-ready";
  return "receiving-arguments";
}

export const WRITE_PREVIEW_BODY_ROWS = 8;
export const WRITE_PREVIEW_MAX_ROWS = 12;

/** Stage label + colors: neutral for in-flight stages (never success green). */
export function stageLabel(stage: WriteStage, theme: Palette, aborted?: boolean): { label: string; painter: (s: string) => string } {
  switch (stage) {
    case "receiving-arguments":
      return { label: "Receiving content · preview, not yet committed", painter: (s) => theme.fg("dim", s) };
    case "arguments-ready":
      return { label: "Content ready · preview, not yet committed", painter: (s) => theme.fg("dim", s) };
    case "executing":
      return { label: "Writing file…", painter: (s) => theme.fg("dim", s) };
    case "succeeded":
      return { label: "Written", painter: (s) => theme.fg("success", s) };
    case "failed-or-aborted":
      return { label: aborted ? "Aborted" : "Failed", painter: (s) => theme.fg("error", s) };
  }
}

/** Cut a raw in-flight string to whole UTF-16 code points: a lone trailing surrogate (from a malformed provider chunk) is dropped. */
export function safePrefix(text: string): string {
  if (!text) return "";
  const last = text.charCodeAt(text.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return text.slice(0, -1);
  return text;
}

export interface WritePreviewLine {
  readonly number: number;
  readonly text: string;
  readonly complete: boolean; // false = last line still open (no trailing \n)
}

/** Build display lines from the raw content prefix (no JSON parsing, no escaping). A final line without a trailing newline is marked incomplete. */
export function previewLines(contentPrefix: string, maxLines: number): { lines: WritePreviewLine[]; totalLogicalLines: number; truncated: boolean } {
  const raw = safePrefix(contentPrefix);
  if (!raw) return { lines: [], totalLogicalLines: 0, truncated: false };
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const all = normalized.split("\n").map((line) => line.replace(/\r$/, ""));
  const totalLogicalLines = all.length;
  const truncated = all.length > maxLines;
  const shown = truncated ? all.slice(-maxLines) : all;
  const firstNumber = truncated ? totalLogicalLines - shown.length + 1 : 1;
  return {
    lines: shown.map((text, i) => ({ number: firstNumber + i, text, complete: !(truncated && i === shown.length - 1) || raw.endsWith("\n") })),
    totalLogicalLines,
    truncated,
  };
}

/**
 * Live preview: stage line + PHYSICAL-ROW tail budget (terminal screen rows,
 * not logical lines). Lines wrap FIRST (gutter + line-number column deducted
 * from body width), then the newest physical rows are kept — an early long
 * logical line cannot freeze the tail and the newest character stays visible.
 * `complete` reflects a real trailing newline, independent of truncation.
 */
export function renderWritePreview(
  contentPrefix: string,
  options: {
    width: number;
    stage: WriteStage;
    expanded: boolean;
    theme: Palette;
    colorLevel: ColorLevel;
    layout: DiffLayoutOps;
    gutter: string;
    /** Rows the CALLER already renders above the body (header). The stage
     * line + hint live INSIDE this budget; the header does not. */
    headerRows?: number;
    /** Explicit physical-row budget for the body (default: WRITE_PREVIEW_MAX_ROWS). */
    maxRows?: number;
  },
): string[] {
  const { width, stage, expanded, theme, colorLevel, gutter } = options;
  const totalBudget = Math.max(1, options.maxRows ?? WRITE_PREVIEW_MAX_ROWS);
  const headerRows = Math.max(0, options.headerRows ?? 0);
  // Defensive fallback (0.8.1 crash lesson): a renderer must NEVER take the host process down — degrade to ASCII layout ops when missing.
  const layout: DiffLayoutOps = options.layout ?? {
    wrap: (text: string) => [text],
    visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
  };
  // Full deduction: gutter + line-number column + one separator space.
  const gutterWidth = Math.max(0, layout.visibleWidth(gutter));
  const bodyBudget = Math.max(1, totalBudget - headerRows - 1 /* stage line */);
  const maxNumber = Number.MAX_SAFE_INTEGER.toString().length;
  // Number width from the ACTUAL last line number, not the total — they differ once truncation starts.
  const raw = safePrefix(contentPrefix);
  const normalized = raw ? (raw.endsWith("\n") ? raw.slice(0, -1) : raw) : "";
  const allLines = normalized ? normalized.split("\n").map((line) => line.replace(/\r$/, "")) : [];
  const totalLogicalLines = allLines.length;
  const numberWidth = Math.min(maxNumber, Math.max(1, String(Math.max(1, totalLogicalLines)).length));
  const bodyWidth = Math.max(1, width - gutterWidth - numberWidth - 1);

  const stageInfo = stageLabel(stage, theme);
  const dim = colorLevel.kind === "none" ? "" : "\x1b[2m";
  const dimOff = colorLevel.kind === "none" ? "" : "\x1b[22m";
  const stageText = totalLogicalLines > 0
    ? stageInfo.label
    : stage === "receiving-arguments" ? "Receiving arguments…" : stageInfo.label;
  const stageRow = `${dim}${gutter}${stageText}${dimOff}`;

  if (!allLines.length) return [stageRow];

  // Walk BACKWARDS wrapping until the budget is filled: one physical row per logical line is only a lower bound — a single long line can consume the whole budget.
  const wrapOne = (text: string): string[] => {
    const wrapped = layout.wrap(text, bodyWidth);
    return wrapped.length ? wrapped : [""];
  };

  interface RenderedLogical { number: number; segments: string[]; complete: boolean }
  const rendered: RenderedLogical[] = [];
  let used = 0;
  const startIndex = Math.max(0, allLines.length - bodyBudget * 4); // sane upper bound for the backward walk
  for (let i = allLines.length - 1; i >= startIndex && used < bodyBudget; i--) {
    const segments = wrapOne(allLines[i]!);
    rendered.unshift({ number: i + 1, segments, complete: i < allLines.length - 1 || raw.endsWith("\n") });
    used += segments.length;
  }
  const truncated = startIndex > 0 || allLines.length > bodyBudget;

  // Keep only the LAST bodyBudget physical rows — the newest content (open tail line, latest chars) is always included.
  const rows: string[] = [];
  const pad = " ".repeat(numberWidth);
  for (const logical of rendered) {
    const number = String(logical.number).padStart(numberWidth);
    logical.segments.forEach((segment, i) => {
      const prefix = i === 0 ? `${gutter}${number} ` : `${gutter}${pad} `;
      rows.push(`${theme.fg("toolTitle", prefix)}${theme.fg("toolOutput", segment)}`);
    });
  }
  const visibleRows = expanded ? rows : rows.slice(-bodyBudget);

  const out: string[] = [stageRow, ...visibleRows];
  if (truncated && !expanded) {
    const firstShown = rendered.length ? rendered[0]!.number : 1;
    const hiddenLogical = firstShown - 1;
    if (hiddenLogical > 0) {
      // The hint consumes body budget: drop the OLDEST rendered row to keep the newest content within the total bound.
      if (out.length >= totalBudget) out.splice(1, 1);
      out.push(`${dim}${gutter}… earlier output (${hiddenLogical} logical line${hiddenLogical === 1 ? "" : "s"}, physical rows elided)${dimOff}`);
    }
  }
  return out;
}
