// Shared segment layout primitives for the chrome blocks (footer, composer
// metadata): tone-tagged plain-text segments and native terminal-cell layout.
// Layout always runs on PLAIN text; painters
// are applied afterwards so final ANSI strings are never sliced.

import { visibleWidth as cellWidth, sliceByColumn } from "@earendil-works/pi-tui";
export { cellWidth };

export type SegmentTone = "normal" | "dim" | "accent" | "warning" | "add" | "del";
export interface Segment {
  text: string;
  tone: SegmentTone;
}

export const SEG_SEP: Segment = { text: " · ", tone: "dim" };

/** Join with dim separators, dropping empty parts. */
export function joined(parts: Array<Segment | undefined>): Segment[] {
  const list = parts.filter((p): p is Segment => p !== undefined && p.text.length > 0);
  const out: Segment[] = [];
  list.forEach((part, i) => {
    if (i > 0) out.push(SEG_SEP);
    out.push(part);
  });
  return out;
}

export function rowWidth(row: Segment[]): number {
  let w = 0;
  for (const seg of row) w += cellWidth(seg.text);
  return w;
}

/** Hard clip plain text without splitting a terminal grapheme. */
export function clipLine(line: string, width: number): string {
  if (cellWidth(line) <= width) return line;
  return sliceByColumn(line, 0, Math.max(0, width), true);
}

/** Cell-level truncation on plain text (paint afterwards). */
export function truncateSegments(row: Segment[], width: number): Segment[] {
  if (rowWidth(row) <= width) return row;
  const out: Segment[] = [];
  let used = 0;
  for (const seg of row) {
    const sw = cellWidth(seg.text);
    if (used + sw <= width) {
      out.push(seg);
      used += sw;
      continue;
    }
    const budget = width - used;
    if (budget >= 2) {
      const text = clipLine(seg.text, budget - 1);
      if (text) out.push({ text: `${text}…`, tone: seg.tone });
    }
    break;
  }
  return out;
}

/** k/M compact: 172000 → "172k", 1_000_000 → "1.0M" (never 1600k). */
export function formatCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    if (m >= 100) return `${Math.round(m)}M`;
    if (m >= 10) return `${Math.round(m * 10) / 10}M`;
    return `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    if (k >= 100) return `${Math.round(k)}k`;
    if (k >= 10) return `${Math.round(k * 10) / 10}k`;
    return `${k.toFixed(1)}k`;
  }
  return String(Math.round(tokens));
}

/**
 * Exact integer for the change counts: 1234 → "1234", never "1.2k". Line
 * counts are the point of the footer's +A −D segment, so they are never
 * rounded into a magnitude.
 */
export function formatExactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return String(Math.round(value));
}

/** 17.2 → "17.2%", 20 → "20%"; null/invalid → undefined (caller omits). */
export function formatPct(pct: number | null | undefined): string | undefined {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  return `${Math.round(pct * 10) / 10}%`;
}
