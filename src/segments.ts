// Shared segment layout primitives for the chrome blocks (footer, composer
// metadata): tone-tagged plain-text segments, CJK-aware cell width, and the
// join-or-wrap row realization. Layout always runs on PLAIN text; painters
// are applied afterwards so final ANSI strings are never sliced.

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

export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1;
  }
  return w;
}

export function rowWidth(row: Segment[]): number {
  let w = 0;
  for (const seg of row) w += cellWidth(seg.text);
  return w;
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
      let text = "";
      let tw = 0;
      for (const ch of seg.text) {
        const cw = cellWidth(ch);
        if (tw + cw > budget - 1) break;
        text += ch;
        tw += cw;
      }
      if (text) out.push({ text: `${text}…`, tone: seg.tone });
    }
    break;
  }
  return out;
}

export interface RowPlan {
  left: Segment[];
  right: Segment[] | undefined;
}

export function planWidths(plan: RowPlan): { left: number; right: number } {
  return { left: rowWidth(plan.left), right: plan.right ? rowWidth(plan.right) : 0 };
}

export function planFits(plan: RowPlan, width: number): boolean {
  const { left, right } = planWidths(plan);
  if (!plan.right) return left <= width;
  return left + right + 2 <= width || (left + 2 <= width && right + 2 <= width);
}

/** Realize a plan at `width`: join with a gap when it fits, otherwise wrap
 * left/right onto separate rows (right-side stats keep their priority head
 * and cell-truncate the tail — never silently deleted). */
export function realizeRow(plan: RowPlan, width: number): Segment[][] {
  const { left, right } = planWidths(plan);
  if (plan.right && left + right + 2 <= width) {
    const gap = width - left - right;
    const merged = [...plan.left];
    if (gap > 0) merged.push({ text: " ".repeat(gap), tone: "normal" });
    merged.push(...plan.right);
    return [merged];
  }
  if (plan.right) {
    return [truncateSegments(plan.left, width), truncateSegments(plan.right, width)];
  }
  return [truncateSegments(plan.left, width)];
}

export function segmentsToText(row: Segment[]): string {
  return row.map((seg) => seg.text).join("");
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

/** 17.2 → "17.2%", 20 → "20%"; null/invalid → undefined (caller omits). */
export function formatPct(pct: number | null | undefined): string | undefined {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  return `${Math.round(pct * 10) / 10}%`;
}
