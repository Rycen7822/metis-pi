// Product status footer below the editor. Metrics stay visible; location and
// ordinary prune messages have independent, component-local disclosures.
// Snapshot scopes: session cumulative I/O, latest confirmed cache rate,
// last completed generation speed, and work-tree changes against HEAD.
// Narrow widths wrap whole fields; painting happens after plain-text layout.

import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageRecord } from "../activity/usage-ledger.ts";
import type { GitChangeStat } from "../git-changes.ts";
import type { ModelSnapshot, ContextUsageSnapshot } from "../host-data.ts";
import { formatSpeedLabel, formatSpeedValue, SPEED_UNIT, type OutputSpeedSample } from "../activity/output-speed.ts";
import { METIS_STATUS_IDS } from "../../collaboration.ts";
import { safeText } from "../../presentation/terminal-text.ts";
import {
  cellWidth, formatCount, formatExactCount, formatPct, rowWidth, SEG_SEP,
  truncateSegments, type Segment,
} from "../../presentation/segments.ts";

export interface FooterSnapshot {
  model: ModelSnapshot | undefined;
  thinkingLevel: string | undefined;
  contextUsage: ContextUsageSnapshot | undefined;
  cwd: string;
  /** Session-scope totals (UsageLedger); undefined = no entries source. */
  session: UsageRecord | undefined;
  /** cache(last) hit rate %, null when unknown. */
  cacheLastPct: number | null;
  /** Latest measurable generation rate; short responses may pool up to three windows. */
  speed: OutputSpeedSample | undefined;
  /** Working-tree change counts vs HEAD; undefined = not a repo / unreadable. */
  changes: GitChangeStat | undefined;
  revision: number;
}

export interface FooterShow {
  /** Model, thinking level, provider and context usage. */
  metadata: boolean;
  /** Session tokens + cache line. */
  details: boolean;
  showCache: boolean;
  showChanges: boolean;
  showSpeed: boolean;
}

export interface FooterDeps {
  getSnapshot: () => FooterSnapshot;
  requestRender: () => void;
  openGoal?: () => void;
  /** Default disclosure state; clicks only change this component's copy. */
  initiallyExpanded?: Record<FooterDisclosure, boolean>;
  /** Config-derived display flags, bound once per install. */
  show: FooterShow;
}

export interface FooterDataView {
  getGitBranch?: () => string | undefined;
  getExtensionStatuses?: () => ReadonlyMap<string, string>;
  onBranchChange?: (cb: () => void) => () => void;
}

type FooterDisclosure = "location" | "prune";
type FooterTarget = FooterDisclosure | "goal";
interface FooterField { segments: Segment[]; separator: Segment }
const SPACE: Segment = { text: " ", tone: "dim" };

/** Wrap whole fields without moving their separator to the next line. */
function wrapFields(fields: FooterField[], width: number): Segment[][] {
  const rows: Segment[][] = [];
  let row: Segment[] = [];
  for (const { segments, separator } of fields) {
    if (!segments.length) continue;
    const next = row.length ? [...row, separator, ...segments] : segments;
    if (row.length && rowWidth(next) > width) {
      rows.push(row);
      row = [];
    }
    row = row.length ? next : truncateSegments(segments, width);
  }
  if (row.length) rows.push(row);
  return rows;
}

export function layoutFooter(snapshot: FooterSnapshot, show: FooterShow, width: number): Segment[][] {
  if (!Number.isFinite(width) || width <= 2) return [];
  const fields: FooterField[] = [];
  const add = (segments: Segment[], separator = SEG_SEP) => fields.push({ segments, separator });
  if (show.metadata) {
    if (snapshot.model?.id) add([{ text: snapshot.model.id, tone: "normal" }]);
    if (snapshot.thinkingLevel) add([{ text: snapshot.thinkingLevel, tone: "accent" }]);
    if (snapshot.model?.provider) add([{ text: snapshot.model.provider, tone: "dim" }]);
    const usage = snapshot.contextUsage;
    const capacity = usage?.contextWindow ?? snapshot.model?.contextWindow;
    if (capacity !== undefined) {
      const tokens = usage?.tokens == null ? "—" : formatCount(usage.tokens);
      const pct = formatPct(usage?.percent);
      add([
        { text: `ctx ${tokens}/${formatCount(capacity)}`, tone: "dim" },
        ...(pct ? [{ text: ` · ${pct}`, tone: (usage?.percent ?? 0) >= 80 ? "warning" as const : "dim" as const }] : []),
      ]);
    }
  }
  const session = snapshot.session;
  if (show.details && session) {
    const io: Segment[] = [{ text: `↑${formatCount(session.input)}`, tone: "normal" }];
    if (session.output > 0) io.push({ text: ` ↓${formatCount(session.output)}`, tone: "normal" });
    add(io, SPACE);
    if (show.showCache) {
      const hit = formatPct(snapshot.cacheLastPct);
      if (hit) add([{ text: "cache ", tone: "dim" }, { text: hit, tone: "normal" }]);
    }
  }
  if (show.showSpeed) {
    const value = formatSpeedValue(snapshot.speed?.tokensPerSecond);
    if (value) add([{ text: `${formatSpeedLabel(snapshot.speed?.sampleCount)} `, tone: "dim" }, { text: value, tone: "normal" }, { text: ` ${SPEED_UNIT}`, tone: "dim" }]);
  }
  const changes = snapshot.changes;
  if (show.showChanges && changes && (changes.additions > 0 || changes.deletions > 0)) {
    add([
      { text: `+${formatExactCount(changes.additions)}`, tone: "add" },
      { text: ` -${formatExactCount(changes.deletions)}`, tone: "del" },
    ], SPACE);
  }
  return wrapFields(fields, width);
}

export function createFooterComponent(
  deps: FooterDeps,
  footerData: FooterDataView | undefined,
  paint: (text: string, tone: Segment["tone"]) => string,
) {
  let branch = footerData?.getGitBranch?.();
  const expanded = { location: false, prune: false, ...deps.initiallyExpanded };
  let targets: Array<{ section: FooterTarget; x: number; y: number; width: number }> = [];
  let pressed: { section: FooterTarget; x: number; y: number } | undefined;
  const unsubscribe = footerData?.onBranchChange?.(() => {
    branch = footerData?.getGitBranch?.();
    deps.requestRender();
  });
  const paintRow = (row: Segment[]) => row.map(seg => paint(seg.text, seg.tone)).join("");
  const detailLines = (text: string, width: number) => text.split("\n")
    .flatMap(line => wrapTextWithAnsi(safeText(line), width)).map(line => paint(line, "dim"));

  return {
    render(width: number): string[] {
      targets = [];
      if (!Number.isFinite(width) || Math.floor(width) <= 2) return [];
      width = Math.floor(width);
      const snapshot = deps.getSnapshot();
      const dir = safeText(snapshot.cwd).replace(/^\/(?:home|Users)\/[^/]+/, "~");
      const location = `${dir}${branch ? ` (${safeText(branch)})` : ""}`.trim();
      const lines = layoutFooter(snapshot, deps.show, width - (location ? 2 : 0)).map(paintRow);
      const disclosure = (section: FooterDisclosure) => {
        if (!lines.length) lines.push("");
        const y = lines.length - 1;
        const gap = lines[y] ? " " : "";
        const glyph = expanded[section] ? "▼" : "▶";
        const glyphX = cellWidth(lines[y]!) + gap.length;
        const x = Math.max(0, glyphX - 2);
        const end = Math.min(width, glyphX + cellWidth(glyph) + 2);
        targets.push({ section, x, y, width: end - x });
        lines[y] += gap + paint(glyph, "dim");
      };
      if (location) {
        disclosure("location");
        if (expanded.location) lines.push(...detailLines(location, width));
      }
      for (const [key, text] of footerData?.getExtensionStatuses?.() ?? []) {
        const [summary = "", ...details] = key === METIS_STATUS_IDS.condense ? (text || key).split("\n") : [text || key];
        const detail = details.join("\n");
        const foldable = key === METIS_STATUS_IDS.condense && detail.length > 0;
        lines.push(paintRow(truncateSegments([{ text: summary, tone: "dim" }], width - (foldable ? 2 : 0))));
        if (key === METIS_STATUS_IDS.goal && deps.openGoal) {
          targets.push({ section: "goal", x: 0, y: lines.length - 1, width: cellWidth(lines.at(-1)!) });
        }
        if (foldable) {
          disclosure("prune");
          if (expanded.prune) lines.push(...detailLines(detail, width));
        }
      }
      return lines;
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      const plainLeft = event.button === "left" && !event.shift && !event.alt && !event.ctrl;
      const hit = targets.find(target => event.y === target.y && event.x >= target.x && event.x < target.x + target.width);
      if (event.type === "press") {
        pressed = plainLeft && hit ? { section: hit.section, x: event.screenX, y: event.screenY } : undefined;
        return pressed ? { handled: true, render: false } : undefined;
      }
      if (!pressed) return;
      if (event.type === "drag" || event.type === "wheel") {
        pressed = undefined;
        return;
      }
      const sameCell = plainLeft && event.screenX === pressed.x && event.screenY === pressed.y;
      if (event.type === "release") {
        if (!sameCell) pressed = undefined;
        return { handled: true, render: false };
      }
      if (event.type === "click") {
        const section = pressed.section;
        pressed = undefined;
        if (sameCell && hit?.section === section) {
          if (section === "goal") deps.openGoal?.();
          else expanded[section] = !expanded[section];
          deps.requestRender();
          return { handled: true, render: true };
        }
      }
      return { handled: true, render: false };
    },
    invalidate(): void {
      // Layout and paint are rebuilt each render; disclosures retain their state.
    },
    dispose(): void {
      targets = [];
      pressed = undefined;
      unsubscribe?.();
    },
  };
}
