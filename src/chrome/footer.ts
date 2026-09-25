// Product status footer below (not inside) the editor surface. Model, effort,
// provider, cwd/branch, context, session I/O and cache appear in that order.
//
// Data contract: a single FooterSnapshot (host-data bridge + usage ledger +
// output-speed tracker + git-changes tracker). Scopes stay
// explicit: Σ = session cumulative, cache = latest confirmed request,
// speed = current/last assistant response, changes = work tree vs HEAD.
//
// Narrow widths wrap whole fields in order; painters apply after layout.

import type { UsageRecord } from "../usage-ledger.ts";
import type { GitChangeStat } from "../git-changes.ts";
import type { ModelSnapshot, ContextUsageSnapshot } from "../host-data.ts";
import { formatSpeedValue, SPEED_UNIT, type OutputSpeedSample } from "../output-speed.ts";
import {
  cellWidth,
  formatCount,
  formatExactCount,
  formatPct,
  rowWidth,
  SEG_SEP,
  truncateSegments,
  type Segment,
} from "../segments.ts";

export interface FooterSnapshot {
  model: ModelSnapshot | undefined;
  thinkingLevel: string | undefined;
  contextUsage: ContextUsageSnapshot | undefined;
  cwd: string;
  /** Session-scope totals (UsageLedger); undefined = no entries source. */
  session: UsageRecord | undefined;
  /** cache(last) hit rate %, null when unknown. */
  cacheLastPct: number | null;
  /** Observed output rate of the in-flight (live) or last completed assistant
   * response; undefined = not measurable yet (segment omitted). */
  speed: OutputSpeedSample | undefined;
  /** Working-tree change counts vs HEAD; undefined = not a repo / unreadable. */
  changes: GitChangeStat | undefined;
  /** Snapshot revision. */
  revision: number;
}

export interface FooterShow {
  /** Model, thinking level, provider and context usage. */
  metadata: boolean;
  /** Session tokens + cache line. */
  details: boolean;
  /** Latest-request cache hit rate. */
  showCache: boolean;
  /** Working-tree +A −D counts (diff colours). */
  showChanges: boolean;
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

/** Wrap whole fields in display order, rather than clipping later fields. */
function wrapFields(fields: Segment[][], width: number): Segment[][] {
  const rows: Segment[][] = [];
  let row: Segment[] = [];
  for (const field of fields) {
    if (!field.length) continue;
    const next = row.length ? [...row, SEG_SEP, ...field] : field;
    if (row.length && rowWidth(next) > width) {
      rows.push(row);
      row = [];
    }
    row = row.length ? [...row, SEG_SEP, ...field] : truncateSegments(field, width);
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Pure layout: model → effort → provider → cwd → context → I/O → cache. */
export function layoutFooter(snapshot: FooterSnapshot, show: FooterShow, width: number, branch: string | undefined): Segment[][] {
  if (!Number.isFinite(width) || width <= 2) return [];

  const fields: Segment[][] = [];
  if (show.metadata) {
    if (snapshot.model?.id) fields.push([{ text: snapshot.model.id, tone: "normal" }]);
    if (snapshot.thinkingLevel) fields.push([{ text: snapshot.thinkingLevel, tone: "accent" }]);
    if (snapshot.model?.provider) fields.push([{ text: snapshot.model.provider, tone: "dim" }]);
  }
  const dir = shortDir(snapshot.cwd, 28);
  const path: Segment[] = [];
  if (dir) {
    path.push({ text: dir, tone: "dim" });
    if (branch) path.push({ text: ` (${branch})`, tone: "normal" });
    // Working-tree change counts ride with the branch, in the diff's own
    // green/red; a clean tree shows nothing at all.
    const changes = snapshot.changes;
    if (show.showChanges && changes && (changes.additions > 0 || changes.deletions > 0)) {
      // Exact integers: the segment is a line count, not a magnitude.
      path.push({ text: ` +${formatExactCount(changes.additions)}`, tone: "add" });
      path.push({ text: ` -${formatExactCount(changes.deletions)}`, tone: "del" });
    }
    fields.push(path);
  }

  if (show.metadata) {
    const usage = snapshot.contextUsage;
    const capacity = usage?.contextWindow ?? snapshot.model?.contextWindow;
    if (capacity !== undefined) {
      const tokens = usage?.tokens == null ? "—" : formatCount(usage.tokens);
      const pct = formatPct(usage?.percent);
      fields.push([
        { text: `ctx ${tokens}/${formatCount(capacity)}`, tone: "dim" },
        ...(pct ? [{ text: ` · ${pct}`, tone: (usage?.percent ?? 0) >= 80 ? "warning" as const : "dim" as const }] : []),
      ]);
    }
  }

  const session = snapshot.session;
  if (show.details && session) {
    const io: Segment[] = [{ text: `↑${formatCount(session.input)}`, tone: "normal" }];
    if (session.output > 0) io.push({ text: ` ↓${formatCount(session.output)}`, tone: "normal" });
    fields.push(io);
    if (show.showCache) {
      const hit = formatPct(snapshot.cacheLastPct);
      if (hit) fields.push([{ text: "cache ", tone: "dim" }, { text: hit, tone: "normal" }]);
    }
  }
  if (show.showSpeed) {
    const value = formatSpeedValue(snapshot.speed?.tokensPerSecond);
    if (value) fields.push([{ text: value, tone: "normal" }, { text: ` ${SPEED_UNIT}`, tone: "dim" }]);
  }

  return wrapFields(fields, width);
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
