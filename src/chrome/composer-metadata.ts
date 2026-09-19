// Composer metadata: the OpenCode-style metadata row that visually belongs to
// the gray prompt surface. Installed through the PUBLIC belowEditor widget
// slot (never injected into the Editor render — that would break mouse
// geometry) and painted with the SAME surface ops as the editor, so editor +
// metadata read as one surface. Contains model · thinking level · provider on
// the left and context usage on the right — nothing else lives here (session
// tokens/cache/quota are the footer's job; no duplication).

import type { ModelSnapshot, ContextUsageSnapshot } from "../host-data.ts";
import { formatCount, joined, realizeRow, type RowPlan, type Segment } from "../segments.ts";

export const COMPOSER_META_WIDGET_KEY = "pi-codex-appearance:composer-meta";

export interface ComposerMetaSnapshot {
  model: ModelSnapshot | undefined;
  thinkingLevel: string | undefined;
  contextUsage: ContextUsageSnapshot | undefined;
  /** Snapshot revision (model/effort/context refresh together). */
  revision: number;
}

export interface ComposerMetaDeps {
  getSnapshot: () => ComposerMetaSnapshot;
  surface: {
    paintRow: (row: string, width: number) => string;
  };
  /** Painter for plain-text tones (normal/dim/warning) AFTER layout. */
  paint: (text: string, tone: Segment["tone"]) => string;
}

/** Pure layout (plain text, CJK-aware). Unknown pieces are omitted; the
 * context capacity prefers the live usage window, then the model's. */
export function layoutComposerMeta(snapshot: ComposerMetaSnapshot, width: number): Segment[][] {
  if (!Number.isFinite(width) || width <= 2) return [];
  const modelSeg: Segment | undefined = snapshot.model
    ? { text: snapshot.model.id, tone: "normal" }
    : undefined;
  const effortSeg: Segment | undefined = snapshot.thinkingLevel
    ? { text: snapshot.thinkingLevel, tone: "accent" }
    : undefined;
  const providerSeg: Segment | undefined = snapshot.model?.provider
    ? { text: snapshot.model.provider, tone: "dim" }
    : undefined;

  const usage = snapshot.contextUsage;
  const capacity = usage?.contextWindow ?? snapshot.model?.contextWindow;
  const ctxSegs: Segment[] = [];
  if (capacity !== undefined) {
    const tokensText = usage?.tokens === null || usage?.tokens === undefined ? "—" : formatCount(usage.tokens);
    const pctSeg: Segment | undefined = usage?.percent !== null && usage?.percent !== undefined
      ? { text: `${Math.round(usage.percent * 10) / 10}%`, tone: usage.percent >= 80 ? "warning" : "dim" }
      : undefined;
    ctxSegs.push(
      { text: "ctx ", tone: "dim" },
      { text: tokensText, tone: "dim" },
      { text: `/${formatCount(capacity)}`, tone: "dim" },
      ...(pctSeg ? [{ text: " · ", tone: "dim" } as Segment, pctSeg] : []),
    );
  }

  const plan: RowPlan = { left: joined([modelSeg, effortSeg, providerSeg]), right: ctxSegs.length ? ctxSegs : undefined };
  if (plan.left.length === 0 && !plan.right) return [];
  return realizeRow(plan, width).map((row) => row.filter((seg) => seg.text.length > 0));
}

export interface ComposerMetaComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export function createComposerMetaComponent(deps: ComposerMetaDeps): ComposerMetaComponent {
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width < 1) return [];
      const snapshot = deps.getSnapshot();
      const rows = layoutComposerMeta(snapshot, width);
      return rows.map((row) => {
        // The context right-block pads with plain spaces painted as surface.
        return deps.surface.paintRow(
          row.map((seg) => (seg.tone === "normal" ? seg.text : deps.paint(seg.text, seg.tone))).join(""),
          width,
        );
      });
    },
    invalidate(): void {
      // Stateless per render — the snapshot getter owns freshness.
    },
  };
}
