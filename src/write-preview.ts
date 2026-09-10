// write-preview.ts — LIVE preview of the args.content the model is still
// generating for a write tool call.
//
// This is a DISPLAY of the in-flight arguments. It never writes to disk,
// never triggers execution, never parses unfinished JSON (the host hands us
// the already-parsed args object via ToolExecutionComponent.updateArgs), and
// never mutates the args themselves.

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

/**
 * Safe-prefix: cut a raw in-flight string to whole UTF-16 code points without
 * emitting a lone surrogate. The raw string may end mid-character only in the
 * sense of chunk boundaries; JS strings are already code-point-safe, but a
 * lone trailing surrogate (from a malformed provider chunk) must be dropped.
 */
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

/**
 * Build display lines from the raw content prefix. Preserves newlines, CRLF
 * (normalized for display only), tabs, fences — NO JSON parsing, NO escaping.
 * A final line without a trailing newline is marked incomplete.
 */
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
 * Render the live preview block: gutter + wrap + budget. Returns [] when
 * there is no content to show (caller then shows the "no content yet" line).
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
  },
): string[] {
  const { width, stage, expanded, theme, colorLevel, layout, gutter } = options;
  const gutterWidth = Math.max(1, layout.visibleWidth(gutter));
  const bodyWidth = Math.max(1, width - gutterWidth);
  const budget = expanded ? Number.MAX_SAFE_INTEGER : WRITE_PREVIEW_BODY_ROWS;
  const { lines, totalLogicalLines, truncated } = previewLines(contentPrefix, budget);
  const out: string[] = [];

  const stageInfo = stageLabel(stage, theme);
  const dim = colorLevel.kind === "none" ? "" : "\x1b[2m";
  const dimOff = colorLevel.kind === "none" ? "" : "\x1b[22m";
  const stageText = totalLogicalLines > 0
    ? stageInfo.label
    : stage === "receiving-arguments" ? "Receiving arguments…" : stageInfo.label;
  out.push(`${dim}${gutter}${stageText}${dimOff}`);

  const numberWidth = String(totalLogicalLines).length;
  const wrapOne = (text: string): string[] => {
    const wrapped = layout.wrap(text, bodyWidth);
    return wrapped.length ? wrapped : [""];
  };

  if (!lines.length) return out;

  const shown = expanded ? previewLines(contentPrefix, Number.MAX_SAFE_INTEGER).lines : lines;
  for (const line of shown) {
    const number = String(line.number).padStart(numberWidth);
    const segments = wrapOne(line.text);
    segments.forEach((segment, i) => {
      const prefix = i === 0 ? `${gutter}${number} ` : `${gutter}${" ".repeat(numberWidth)} `;
      out.push(`${theme.fg("toolTitle", prefix)}${theme.fg("toolOutput", segment)}`);
    });
  }
  if (truncated && !expanded) {
    const hidden = totalLogicalLines - shown.length;
    out.push(`${dim}${gutter}… first ${hidden} line${hidden === 1 ? "" : "s"} hidden (${WRITE_PREVIEW_MAX_ROWS - 1 - WRITE_PREVIEW_BODY_ROWS >= 0 ? "ctrl+o" : "expand"} for received prefix)${dimOff}`);
  }
  return out.slice(0, expanded ? out.length : WRITE_PREVIEW_MAX_ROWS);
}
