// The standalone Working line, installed as an above-editor widget through
// the host's public ctx.ui.setWidget(key, factory, {placement:"aboveEditor"}).
// Segment order follows the Zentui working line (reference only, no
// dependency): Message · Tool · Elapsed · Thought · Tokens.
// The native loader row is hidden ONLY after this widget installed
// successfully (setWorkingVisible(false)); any failure keeps the native row.
// Live width comes from the host render pass — no fixed column count.

import { formatDuration, formatTokensCompact, type ActivityPhase } from "../ui-metrics.ts";

export interface WorkingSnapshot {
  active: boolean;
  phase: ActivityPhase;
  elapsedMs: number;
  thinkingMs: number;
  thinkingOpen: boolean;
  usage: { input: number; output: number };
  tools: { first: string; count: number } | undefined;
}

/** Config-gated segments. `elapsed:false` removes ONLY the duration — the
 * thought/phase/tool/tokens segments keep updating. */
export interface WorkingShow {
  elapsed: boolean;
  thought: boolean;
  tool: boolean;
  tokens: boolean;
}

export const WORKING_WIDGET_KEY = "pi-codex-appearance:working";

/** Pure line builder (testable without a terminal). Unknown/zero pieces are
 * omitted, never fabricated: no tools → no tool segment; zero tokens → no
 * token segment; thinking 0 & closed → no thought segment. */
export function formatWorkingLine(s: WorkingSnapshot, show: WorkingShow): string {
  const parts: string[] = [];
  switch (s.phase) {
    case "writing":
      parts.push("Writing…");
      break;
    case "waiting-for-input":
      parts.push("Waiting for input");
      break;
    default:
      parts.push("Working…");
      break;
  }
  if (show.tool && s.tools) {
    parts.push(s.tools.count > 1 ? `${s.tools.first} +${s.tools.count - 1}` : s.tools.first);
  }
  if (show.elapsed) parts.push(formatDuration(s.elapsedMs));
  if (show.thought) {
    if (s.thinkingOpen && s.thinkingMs > 0) parts.push(`thinking ${formatDuration(s.thinkingMs)}`);
    else if (!s.thinkingOpen && s.thinkingMs > 0) parts.push(`thought for ${formatDuration(s.thinkingMs)}`);
  }
  if (show.tokens && (s.usage.input > 0 || s.usage.output > 0)) {
    parts.push(`↑${formatTokensCompact(s.usage.input)} ↓${formatTokensCompact(s.usage.output)}`);
  }
  return parts.join(" · ");
}

export interface WorkingComponentInput {
  getSnapshot: () => WorkingSnapshot;
  getShow: () => WorkingShow;
  /** Accent painter for the marker (fallback: plain). */
  accent?: (text: string) => string;
  /** DIM painter for the body (fallback: plain). */
  dim?: (text: string) => string;
}

/** Host Component shape (structural — no host imports in src/). */
export interface WorkingComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

/** Marker: ✦ (accent) with ASCII fallback when the terminal/theme is plain. */
function marker(accent: ((t: string) => string) | undefined): string {
  const glyph = "✦";
  if (!accent) return glyph;
  try {
    const painted = accent(glyph);
    return painted === glyph ? "*" : painted;
  } catch {
    return "*";
  }
}

export function createWorkingComponent(input: WorkingComponentInput): WorkingComponent {
  return {
    render(width: number): string[] {
      if (!Number.isFinite(width) || width < 1) return [];
      const snapshot = input.getSnapshot();
      if (!snapshot.active) return [];
      const line = formatWorkingLine(snapshot, input.getShow());
      if (!line) return [];
      const dim = input.dim ?? ((t: string) => t);
      const head = marker(input.accent);
      // Cell-width guard: hide decorations, never overflow the widget row.
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (plain.length + 2 > width) {
        // Cell guard: head + space + ellipsis consume 3 columns.
        const budget = width - 3;
        return budget >= 1 ? [`${head} ${plain.slice(0, budget)}…`] : [head.slice(0, Math.max(1, width))];
      }
      return [`${head} ${dim(line)}`];
    },
    invalidate(): void {
      // Stateless per render — the snapshot getters own freshness.
    },
  };
}
