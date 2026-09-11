// Compact product status footer (below the composer surface). 0.8.5: the
// model/effort/provider/context details moved INTO the composer surface
// (composer-metadata.ts) — the footer carries cwd/branch + session usage +
// cache + Codex quota (+ optional R/W and cost at wide widths), never a
// duplicate model/context line.
//
// Data contract: a single FooterSnapshot (host-data bridge + usage ledger +
// quota store). Scopes stay explicit: Σ = session cumulative, cache = latest
// confirmed request, quota = codex app-server (unknown → omitted, never 0%).
//
// Priority ladder as width shrinks: cost → R/W → shorter dir → wrap to two
// rows — P0 (cwd/branch, session I/O) and P1 (cache, quota) always survive.
// Layout runs on PLAIN segment text; painters apply afterwards.

import type { UsageRecord } from "../usage-ledger.ts";
import { formatQuotaLine, type CodexQuotaSnapshot } from "../quota/types.ts";
import {
  cellWidth,
  formatCount,
  formatPct,
  realizeRow,
  SEG_SEP,
  truncateSegments,
  type RowPlan,
  type Segment,
} from "../segments.ts";

export interface FooterSnapshot {
  cwd: string;
  /** Session-scope totals (UsageLedger); undefined = no entries source. */
  session: UsageRecord | undefined;
  /** cache(last) hit rate %, null when unknown. */
  cacheLastPct: number | null;
  /** Codex quota snapshot from the quota store (undefined = unavailable). */
  quota: CodexQuotaSnapshot | undefined;
  /** True when the quota snapshot is known-stale (refresh failed). */
  quotaStale: boolean;
  /** Snapshot revision. */
  revision: number;
}

export interface FooterShow {
  /** Session tokens + cache line. */
  details: boolean;
  /** Latest-request cache hit rate. */
  showCache: boolean;
  /** cacheRead/cacheWrite amounts. */
  showCacheReadWrite: boolean;
  /** Known cost. */
  showCost: boolean;
  /** Codex subscription quota. */
  showCodexQuota: boolean;
}

export interface FooterDeps {
  getSnapshot: () => FooterSnapshot;
  requestRender: () => void;
  /** Config-derived display flags, bound once per install. */
  show: FooterShow;
}

export interface FooterDataView {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  onBranchChange?: (cb: () => void) => () => void;
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

/** Pure layout: cwd/branch left; right groups in priority order with
 * narrow-width reductions. Returns 1..2 rows. */
export function layoutFooter(snapshot: FooterSnapshot, show: FooterShow, width: number, branch: string | undefined): Segment[][] {
  if (!Number.isFinite(width) || width <= 2) return [];

  const dir = shortDir(snapshot.cwd, 28);
  const left: Segment[] = [];
  if (dir) {
    left.push({ text: dir, tone: "dim" });
    if (branch) left.push({ text: ` (${branch})`, tone: "normal" });
  }

  // Right groups by priority: P0 session I/O, P1 cache + quota, P2 R/W + cost.
  const session = snapshot.session;
  const right: Segment[] = [];
  if (show.details && session) {
    right.push({ text: `↑${formatCount(session.input)}`, tone: "normal" });
    if (session.output > 0) right.push({ text: ` ↓${formatCount(session.output)}`, tone: "normal" });
    if (show.showCache) {
      const hit = formatPct(snapshot.cacheLastPct);
      if (hit) right.push(SEG_SEP, { text: "cache ", tone: "dim" }, { text: hit, tone: "normal" });
    }
    if (show.showCodexQuota) {
      const quotaLine = formatQuotaLine(snapshot.quota, snapshot.quotaStale);
      if (quotaLine) right.push(SEG_SEP, { text: quotaLine, tone: "normal" });
    }
    if (show.showCacheReadWrite && (session.cacheRead > 0 || session.cacheWrite > 0)) {
      right.push(SEG_SEP, { text: `R${formatCount(session.cacheRead)}`, tone: "normal" });
      right.push({ text: ` W${formatCount(session.cacheWrite)}`, tone: "normal" });
    }
    if (show.showCost && session.costTotal !== undefined && Number.isFinite(session.costTotal)) {
      right.push(SEG_SEP, { text: `$${session.costTotal.toFixed(2)}`, tone: "dim" });
    }
  }
  if (left.length === 0 && right.length === 0) return [];

  const plan: RowPlan = { left, right: right.length ? right : undefined };
  return realizeRow(plan, width).filter((r) => r.length > 0);
}

// ---------- component ----------

export function createFooterComponent(
  deps: FooterDeps,
  footerData: FooterDataView | undefined,
  paint: (text: string, tone: Segment["tone"]) => string,
) {
  let branch: string | undefined = footerData?.getGitBranch?.();
  const unsubscribe = footerData?.onBranchChange?.(() => {
    branch = footerData?.getGitBranch?.();
    deps.requestRender();
  });

  return {
    render(width: number): string[] {
      const snapshot = deps.getSnapshot();
      const rows = layoutFooter(snapshot, deps.show, width, branch);
      const lines = rows.map((row) => row.map((seg) => paint(seg.text, seg.tone)).join(""));
      const statuses = footerData?.getExtensionStatuses?.();
      if (statuses && statuses.size > 0) {
        for (const [key, text] of statuses) {
          const line = text || key;
          if (line) {
            lines.push(
              truncateSegments([{ text: line, tone: "dim" }], Math.max(1, Math.floor(width)))
                .map((seg) => paint(seg.text, "dim")).join(""),
            );
          }
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
