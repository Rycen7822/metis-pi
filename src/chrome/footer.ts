// Two-line Codex-style footer details (above the input area, via the public
// setFooter slot). Line 1: model · effort · provider left, context usage
// right. Line 2: dir (branch) left, session Σ tokens · cache(last) · R/W
// right. Third-party setStatus() texts keep their own rows.
//
// Data contract: a single FooterSnapshot from the host-data bridge + usage
// ledger — components never guess host fields individually. Scopes are
// explicit: ctx = live context usage, Σ = session cumulative (this session
// file's recorded entries), cache(last) = most recent confirmed request on
// the active branch. Unknown values render "—" or are omitted — never 0.
//
// Layout is computed on PLAIN segment text at cell width (CJK-aware), then
// painted — final ANSI strings are never .slice()d. Narrow widths wrap
// groups onto their own rows instead of deleting the right-side stats.

import { formatTokensCompact } from "../ui-metrics.ts";
import type { ModelSnapshot, ContextUsageSnapshot } from "../host-data.ts";
import type { UsageRecord } from "../usage-ledger.ts";

export interface FooterSnapshot {
  /** Live model (id is the default display). */
  model: ModelSnapshot | undefined;
  /** Live thinking level ("off" shown explicitly). */
  thinkingLevel: string | undefined;
  /** Live ctx.getContextUsage(). */
  contextUsage: ContextUsageSnapshot | undefined;
  cwd: string;
  /** Session-scope totals (UsageLedger); undefined = no entries source. */
  session: UsageRecord | undefined;
  /** cache(last) hit rate %, null when unknown. */
  cacheLastPct: number | null;
  /** Session weighted hit rate %, null when unknown. */
  cacheSessionPct: number | null;
  /** Snapshot revision (model/effort/context changed together). */
  revision: number;
}

export interface FooterShow {
  /** Second detail line (session tokens / cache). */
  details: boolean;
  showCache: boolean;
  showCost: boolean;
}

export type SegmentTone = "normal" | "dim" | "accent";
export interface Segment {
  text: string;
  tone: SegmentTone;
}

export interface FooterDeps {
  getSnapshot: () => FooterSnapshot;
  requestRender: () => void;
}

export interface FooterDataView {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  onBranchChange?: (cb: () => void) => () => void;
}

/** k/M compact: 172000 → "172k", 1_000_000 → "1.0M", 1_600_000 → "1.6M"
 * (never 1600k; one decimal kept below 10M for stable column alignment). */
export function formatCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    if (m >= 100) return `${Math.round(m)}M`;
    if (m >= 10) return `${Math.round(m * 10) / 10}M`;
    return `${m.toFixed(1)}M`;
  }
  return formatTokensCompact(tokens);
}

function formatPct(pct: number | null): string | undefined {
  if (pct === null || !Number.isFinite(pct)) return undefined;
  return `${Math.round(pct * 10) / 10}%`;
}

function shortDir(cwd: string, max: number): string {
  if (!cwd) return "";
  const home = /^\/(?:home|Users)\/[^/]+/;
  let out = home.test(cwd) ? cwd.replace(home, "~") : cwd;
  if (cellWidth(out) > max) {
    const tail = out.slice(-max);
    const slash = tail.indexOf("/");
    out = slash >= 0 ? `…${tail.slice(slash)}` : `…${tail}`;
  }
  return out;
}

// ---------- pure layout ----------

const SEP: Segment = { text: " · ", tone: "dim" };

function joined(parts: Segment[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((part, i) => {
    if (i > 0) out.push(SEP);
    out.push(part);
  });
  return out;
}

function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && 0xd7a3 >= code) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff))) ? 2 : 1;
  }
  return w;
}

function rowWidth(row: Segment[]): number {
  let w = 0;
  for (const seg of row) w += cellWidth(seg.text);
  return w;
}

/** Cell-level truncation on PLAIN text (callers paint afterwards). */
function truncateSegments(row: Segment[], width: number): Segment[] {
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

interface RowPlan {
  left: Segment[];
  right: Segment[] | undefined;
}

/** Build the two detail rows (+ optional status rows) as segment plans for
 * `width` cells. Reductions at narrow widths: shorten dir → drop provider →
 * wrap right groups onto their own rows → cell-truncate. The right-side
 * stats are never silently deleted; they reappear when width returns. */
export function layoutFooter(snapshot: FooterSnapshot, show: FooterShow, width: number, branch: string | undefined): Segment[][] {
  if (!Number.isFinite(width) || width <= 2) return [];
  const rows: RowPlan[] = [];

  // id is the default display; name stays available for future use.
  const modelSeg: Segment | undefined = snapshot.model
    ? { text: snapshot.model.id, tone: "accent" }
    : undefined;
  const effortSeg: Segment | undefined = snapshot.thinkingLevel
    ? { text: snapshot.thinkingLevel, tone: "normal" }
    : undefined;
  const providerSeg: Segment | undefined = snapshot.model?.provider
    ? { text: snapshot.model.provider, tone: "dim" }
    : undefined;

  // Right 1: ctx 172k/1.0M · 17.2%  (capacity from live usage or the model).
  const usage = snapshot.contextUsage;
  const capacity = usage?.contextWindow ?? snapshot.model?.contextWindow;
  const ctxSegs: Segment[] = [];
  if (capacity !== undefined) {
    const tokensText = usage?.tokens === null || usage?.tokens === undefined ? "—" : formatCount(usage.tokens);
    const parts: Segment[] = [{ text: "ctx ", tone: "dim" }, { text: tokensText, tone: "normal" }, { text: `/${formatCount(capacity)}`, tone: "dim" }];
    const pct = formatPct(usage?.percent ?? null);
    if (pct) parts.push(SEP, { text: pct, tone: "normal" });
    ctxSegs.push(...parts);
  }

  // Left 1 reductions for narrow widths.
  const wideLeft1 = joined([modelSeg, effortSeg, providerSeg].filter((s): s is Segment => s !== undefined));
  const midLeft1 = joined([modelSeg, effortSeg].filter((s): s is Segment => s !== undefined));
  const narrowLeft1 = joined([modelSeg].filter((s): s is Segment => s !== undefined));

  rows.push({ left: wideLeft1, right: ctxSegs.length ? ctxSegs : undefined });
  let fits = planFits(rows[rows.length - 1], width);
  if (!fits && rowWidth(midLeft1) < rowWidth(wideLeft1)) {
    rows[rows.length - 1] = { left: midLeft1, right: ctxSegs.length ? ctxSegs : undefined };
    fits = planFits(rows[rows.length - 1], width);
  }
  if (!fits && rowWidth(narrowLeft1) < rowWidth(midLeft1)) {
    rows[rows.length - 1] = { left: narrowLeft1, right: ctxSegs.length ? ctxSegs : undefined };
    fits = planFits(rows[rows.length - 1], width);
  }

  if (show.details) {
    // Left 2: dir (branch).
    const dir = shortDir(snapshot.cwd, 28);
    const dirSegs: Segment[] = [];
    if (dir) {
      dirSegs.push({ text: dir, tone: "dim" });
      if (branch) dirSegs.push({ text: ` (${branch})`, tone: "normal" });
    }
    // Right 2: Σ↑205k ↓19.2k · cache(last) 98.4% · R1.6M W0 [· $0.42]
    const right2: Segment[] = [];
    const session = snapshot.session;
    if (session) {
      right2.push({ text: "Σ", tone: "dim" });
      right2.push({ text: `↑${formatCount(session.input)}`, tone: "normal" });
      if (session.output > 0) right2.push({ text: ` ↓${formatCount(session.output)}`, tone: "normal" });
      if (show.showCache) {
        const last = formatPct(snapshot.cacheLastPct);
        if (last) right2.push(SEP, { text: "cache(last) ", tone: "dim" }, { text: last, tone: "normal" });
      }
      right2.push(SEP, { text: `R${formatCount(session.cacheRead)}`, tone: "normal" });
      if (session.cacheWrite > 0 || rowWidth(right2) + 8 <= width) {
        right2.push({ text: ` W${formatCount(session.cacheWrite)}`, tone: "normal" });
      }
      if (show.showCost && session.costTotal !== undefined && Number.isFinite(session.costTotal)) {
        right2.push(SEP, { text: `$${session.costTotal.toFixed(2)}`, tone: "dim" });
      }
    }
    if (dirSegs.length || right2.length) rows.push({ left: dirSegs, right: right2.length ? right2 : undefined });
  }

  // Realize rows: join or wrap.
  const out: Segment[][] = [];
  for (const plan of rows) {
    const leftW = rowWidth(plan.left);
    const rightW = plan.right ? rowWidth(plan.right) : 0;
    if (plan.right && leftW + rightW + 2 <= width) {
      const gap = width - leftW - rightW;
      const merged = [...plan.left];
      if (gap > 0) merged.push({ text: " ".repeat(gap), tone: "normal" });
      merged.push(...plan.right);
      out.push(merged);
    } else if (plan.right) {
      // Narrow: wrap groups onto separate rows instead of dropping stats;
      // each group keeps its left-priority head and cell-truncates the tail.
      out.push(truncateSegments(plan.left, width));
      out.push(truncateSegments(plan.right, width));
    } else {
      out.push(truncateSegments(plan.left, width));
    }
  }
  return out.filter((row) => row.length > 0);
}

function planFits(plan: RowPlan, width: number): boolean {
  const leftW = rowWidth(plan.left);
  const rightW = plan.right ? rowWidth(plan.right) : 0;
  if (!plan.right) return leftW <= width;
  return leftW + rightW + 2 <= width || (leftW + 2 <= width && rightW + 2 <= width);
}

// ---------- component ----------

/** The component produced by our setFooter factory. Paints the laid-out
 * segments; the theme may be an unbound proxy early on — resolve lazily. */
export function createFooterComponent(
  deps: FooterDeps,
  footerData: FooterDataView | undefined,
  theme: { fg?: (key: string, text: string) => string } | undefined,
  show: FooterShow = { details: true, showCache: true, showCost: true },
) {
  let branch: string | undefined = footerData?.getGitBranch?.();
  const unsubscribe = footerData?.onBranchChange?.(() => {
    branch = footerData?.getGitBranch?.();
    deps.requestRender();
  });

  const paint = (): ((key: string, text: string) => string) => {
    const probe = (fg: (k: string, t: string) => string): boolean => {
      try {
        const probeText = "\u0000probe";
        return typeof fg("dim", probeText) === "string" && fg("dim", probeText) !== probeText;
      } catch {
        return false;
      }
    };
    if (theme && typeof theme.fg === "function" && probe(theme.fg)) {
      return (k, t) => (theme as { fg: (k: string, t: string) => string }).fg(k, t);
    }
    return (_k: string, t: string) => t;
  };

  return {
    render(width: number): string[] {
      const painter = paint();
      const snapshot = deps.getSnapshot();
      const rows = layoutFooter(snapshot, show, width, branch);
      const lines = rows.map((row) => row
        .map((seg) => (seg.tone === "normal" ? seg.text : painter(seg.tone, seg.text)))
        .join(""));
      const statuses = footerData?.getExtensionStatuses?.();
      if (statuses && statuses.size > 0) {
        for (const [key, text] of statuses) {
          const line = text || key;
          if (line) lines.push(truncateSegments([{ text: line, tone: "dim" }], Math.max(1, Math.floor(width)))
            .map((seg) => painter("dim", seg.text)).join(""));
        }
      }
      return lines;
    },
    invalidate(): void {
      // Stateless per render — the snapshot getter owns freshness.
    },
    dispose(): void {
      unsubscribe?.();
    },
  };
}
