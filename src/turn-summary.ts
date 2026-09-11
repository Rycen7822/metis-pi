// turn-summary.ts — the "Worked for …" end-of-interaction summary.
//
// The ONLY persistence exception granted to this extension: a UI-metrics
// CustomEntry appended via the public pi.appendEntry() and rendered by
// pi.registerEntryRenderer(). Custom entries never enter LLM context
// (verified v0.85.1). Session JSONL is never edited directly; existing
// entries are never rewritten; message bodies are never stored.

import { formatDuration, formatTokensCompact, type InteractionSnapshot } from "./ui-metrics.ts";

export const SUMMARY_CUSTOM_TYPE = "pi-codex-appearance:interaction-summary:v1";

export interface InteractionSummaryData {
  schemaVersion: 1;
  /** Interaction identity: the metrics generation + wall-clock start. */
  interactionId: string;
  /** Branch anchor: entry id this interaction started after (stable host
   * anchor when available), or undefined when the host gives none. */
  branchAnchor?: string;
  startedAt: number; // wall clock epoch ms
  settledAt: number; // wall clock epoch ms
  elapsedMs: number;
  thinkingMs?: number; // omitted when unknown
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outcome: "completed" | "interrupted" | "failed" | "completed-estimate";
}

export interface TurnSummaryDeps {
  /** Public API: append a custom entry (never present in --no-session). */
  appendEntry?: (customType: string, data?: unknown) => void;
  /** Public API: register the renderer for our custom entry. */
  registerEntryRenderer?: (customType: string, renderer: unknown) => void;
  /** Persist gate (config summary.persist). */
  persist: boolean;
  /** Wall clock. */
  wall: () => number;
  /** Theme for rendering (injected at register time by index.ts). */
}

/** Build the summary line text (Codex grammar). Unknown pieces are omitted. */
export function formatSummaryLine(
  snapshot: InteractionSnapshot,
  outcome: InteractionSummaryData["outcome"],
): string {
  const parts: string[] = [];
  const dur = formatDuration(snapshot.elapsedMs);
  if (outcome === "interrupted") parts.push(`Interrupted after ${dur}`);
  else if (outcome === "failed") parts.push(`Failed after ${dur}`);
  else parts.push(`Worked for ${dur}`);
  if (snapshot.thinkingMs > 0) parts.push(`thought for ${formatDuration(snapshot.thinkingMs)}`);
  const { input, output } = snapshot.usage;
  if (output > 0) parts.push(`↓${formatTokensCompact(output)}`);
  if (input > 0) parts.push(`↑${formatTokensCompact(input)}`);
  return parts.join(" · ");
}

export class TurnSummary {
  #deps: TurnSummaryDeps;
  /** One record per settled interaction id — reload/resume/duplicate events
   * never append twice. */
  #written = new Set<string>();

  constructor(deps: TurnSummaryDeps) {
    this.#deps = deps;
    this.#deps.registerEntryRenderer?.(SUMMARY_CUSTOM_TYPE, makeEntryRenderer());
  }

  /** Called from the metrics onSettled callback. */
  record(snapshot: InteractionSnapshot, outcome: InteractionSummaryData["outcome"], branchAnchor?: string): void {
    const interactionId = `i${snapshot.startedAt ?? 0}`;
    if (this.#written.has(interactionId)) return;
    this.#written.add(interactionId);
    // Bound the set: keep the last 32 interaction ids.
    if (this.#written.size > 32) {
      const first = this.#written.values().next().value;
      if (first !== undefined) this.#written.delete(first);
    }

    const data: InteractionSummaryData = {
      schemaVersion: 1,
      interactionId,
      branchAnchor,
      startedAt: snapshot.startedAt ?? this.#deps.wall() - snapshot.elapsedMs,
      settledAt: this.#deps.wall(),
      elapsedMs: snapshot.elapsedMs,
      outcome,
    };
    if (snapshot.thinkingMs > 0) data.thinkingMs = snapshot.thinkingMs;
    const u = snapshot.usage;
    if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
      data.usage = {};
      if (u.input > 0) data.usage.input = u.input;
      if (u.output > 0) data.usage.output = u.output;
      if (u.cacheRead > 0) data.usage.cacheRead = u.cacheRead;
      if (u.cacheWrite > 0) data.usage.cacheWrite = u.cacheWrite;
    }

    if (this.#deps.persist && this.#deps.appendEntry) {
      try {
        this.#deps.appendEntry(SUMMARY_CUSTOM_TYPE, data);
      } catch {
        // Fall through to the ephemeral path below — never crash the host.
      }
    }
  }

  /** Reload/new session: old ids must not suppress new summaries. */
  forgetSession(): void {
    this.#written.clear();
  }

  get writtenCount(): number {
    return this.#written.size;
  }
}

// ---- entry renderer (display-only; needs a Component factory from the host) ---

export type SummaryEntryRendererDeps = {
  makeText: (text: string, paddingX?: number, paddingY?: number) => ComponentLike;
};

export interface ComponentLike {
  render(width: number): string[];
}

/** The renderer registered for our custom type. Receives the entry data and
 * returns a small dim component — display copy only. */
export function makeEntryRenderer(makeText?: SummaryEntryRendererDeps["makeText"]) {
  return (entry: { customType: string; data?: unknown }, _options: unknown, theme?: { fg?: (k: string, t: string) => string }) => {
    const data = entry?.data as InteractionSummaryData | undefined;
    if (!data || data.schemaVersion !== 1) return undefined;
    const snapshot: InteractionSnapshot = {
      active: false,
      phase: "idle",
      startedAt: data.startedAt,
      elapsedMs: data.elapsedMs,
      thinkingMs: data.thinkingMs ?? 0,
      thinkingOpen: false,
      usage: {
        input: data.usage?.input ?? 0,
        output: data.usage?.output ?? 0,
        cacheRead: data.usage?.cacheRead ?? 0,
        cacheWrite: data.usage?.cacheWrite ?? 0,
      },
    };
    const line = formatSummaryLine(snapshot, data.outcome === "completed-estimate" ? "completed" : data.outcome);
    if (!line) return undefined;
    // The theme handed to entry renderers may be an unbound proxy (early
    // restore rendering). Resolve lazily with the same probe as chrome.
    const resolvePainter = (): (k: string, t: string) => string => {
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
      const globalTheme = (globalThis as Record<symbol, unknown>)[
        Symbol.for("@earendil-works/pi-coding-agent:theme")
      ] as { fg?: (k: string, t: string) => string } | undefined;
      if (globalTheme && typeof globalTheme.fg === "function" && probe(globalTheme.fg)) {
        return (k, t) => (globalTheme as { fg: (k: string, t: string) => string }).fg(k, t);
      }
      return (_k: string, t: string) => t;
    };
    const painter = resolvePainter();
    if (makeText) return makeText(painter("dim", line));
    return {
      render: (width: number) => [painter("dim", line.slice(0, Math.max(0, width)))],
    };
  };
}
