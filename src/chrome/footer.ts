// Compact product status footer (below the composer surface). 0.8.5: the
// model/effort/provider/context details moved INTO the composer surface
// (composer-metadata.ts) — the footer carries cwd/branch (+ working-tree change
// counts) + session usage + cache + Codex quota, never a duplicate
// model/context line.
//
// Data contract: a single FooterSnapshot (host-data bridge + usage ledger +
// quota store + output-speed tracker + git-changes tracker). Scopes stay
// explicit: Σ = session cumulative, cache = latest confirmed request,
// speed = current/last assistant response, quota = codex app-server
// (unknown → omitted, never 0%), changes = work tree vs HEAD.
//
// Priority ladder as width shrinks: shorter dir → wrap to two rows —
// P0 (cwd/branch, change counts, output speed, session I/O) and P1 (cache,
// quota) always survive. Speed sits at the HEAD of the right block, in the
// slot left of ↑input (where a rate is read next to the totals it came from).
// Layout runs on PLAIN segment text; painters apply afterwards.

import type { UsageRecord } from "../usage-ledger.ts";
import type { GitChangeStat } from "../git-changes.ts";
import { formatSpeedValue, SPEED_UNIT, type OutputSpeedSample } from "../output-speed.ts";
import { formatQuotaLine, type CodexQuotaSnapshot } from "../quota/types.ts";
import {
  cellWidth,
  formatCount,
  formatExactCount,
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
  /** Observed output rate of the in-flight (live) or last completed assistant
   * response; undefined = not measurable yet (segment omitted). */
  speed: OutputSpeedSample | undefined;
  /** Working-tree change counts vs HEAD; undefined = not a repo / unreadable. */
  changes: GitChangeStat | undefined;
  /** Snapshot revision. */
  revision: number;
}

export interface FooterShow {
  /** Session tokens + cache line. */
  details: boolean;
  /** Latest-request cache hit rate. */
  showCache: boolean;
  /** Working-tree +A −D counts (diff colours). */
  showChanges: boolean;
  /** Codex subscription quota. */
  showCodexQuota: boolean;
  /** Observed model output speed (tok/s). */
  showSpeed: boolean;
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
    // Working-tree change counts ride with the branch, in the diff's own
    // green/red; a clean tree shows nothing at all.
    const changes = snapshot.changes;
    if (show.showChanges && changes && (changes.additions > 0 || changes.deletions > 0)) {
      // Exact integers: the segment is a line count, not a magnitude.
      left.push({ text: ` +${formatExactCount(changes.additions)}`, tone: "add" });
      left.push({ text: ` -${formatExactCount(changes.deletions)}`, tone: "del" });
    }
  }

  // Right groups by priority: P0 output speed + session I/O, P1 cache + quota.
  const session = snapshot.session;
  const right: Segment[] = [];
  // Output speed leads the right block: the rate of the response these totals
  // just grew by, read immediately left of ↑input.
  if (show.showSpeed) {
    const value = formatSpeedValue(snapshot.speed?.tokensPerSecond);
    if (value) right.push({ text: value, tone: "normal" }, { text: ` ${SPEED_UNIT}`, tone: "dim" });
  }
  if (show.details && session) {
    if (right.length > 0) right.push(SEG_SEP);
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
