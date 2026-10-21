// The ONLY persistence exception granted to this extension: a UI-metrics
// CustomEntry appended via the public pi.appendEntry() and rendered by
// pi.registerEntryRenderer(). Custom entries never enter LLM context
// (verified v0.85.1); session JSONL is never edited directly, existing entries
// are never rewritten, message bodies are never stored.
//
// schemaVersion 2 records the RUNTIME verdict: outcome + terminal evidence +
// attempt order + toolErrorsObserved. v1 entries remain readable; a v1
// "failed" was written by the old sticky-flag bug and lacks verifiable
// terminal evidence, so it renders as "legacy status unverified" — history is
// never rewritten in either direction.

import type { InteractionSnapshot } from "./ui-metrics.ts";
import { formatDuration, formatTokensCompact } from "../../presentation/segments.ts";
import type { InteractionOutcome, TerminalEvidence } from "./interaction-outcome.ts";
import { resolveThemePainter } from "../../presentation/palette.ts";
import { clipLine } from "../../presentation/segments.ts";
import { formatBeijingTime } from "../transcript/message-timestamp.ts";

export const SUMMARY_CUSTOM_TYPE = "metis-pi:interaction-summary:v1";

export type SummaryOutcome = InteractionOutcome | "completed-estimate";

export interface InteractionSummaryData {
  schemaVersion: 1 | 2;
  /** Interaction identity: the metrics generation + wall-clock start. */
  interactionId: string;
  /** Branch anchor: entry id this interaction started after (stable host
   * anchor when available), or undefined when the host gives none. */
  branchAnchor?: string;
  startedAt: number; // wall clock epoch ms
  settledAt: number; // wall clock epoch ms
  replyEndedAt?: number; // final assistant message end, before background maintenance
  elapsedMs: number;
  thinkingMs?: number; // omitted when unknown
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** v2 runtime verdict (v1: completed|interrupted|failed|completed-estimate). */
  outcome: SummaryOutcome;
  /** v2: what actually ended the run. */
  evidence?: TerminalEvidence;
  /** v2: diagnostics-safe reason (no message bodies). */
  reason?: string;
  /** v2: attempts observed; v1 readers ignore. */
  attempt?: number;
  /** Tool errors seen during the run — diagnostic count only, never the
   * verdict basis. Not appended to the default summary line. */
  toolErrorsObserved?: number;
}

export interface TurnSummaryDeps {
  /** Public API: append a custom entry (never present in --no-session). */
  appendEntry?: (customType: string, data?: unknown) => void;
  registerEntryRenderer?: (customType: string, renderer: unknown) => void;
  persist: boolean;
  /** Wall clock. */
  wall: () => number;
}

/** v1 outcomes mapped through the legacy lens: the old failed flag was set by
 * ANY tool error, so it is NOT trustworthy terminal evidence. */
function legacyOutcome(outcome: SummaryOutcome): { outcome: InteractionOutcome; legacyUnverified: boolean } {
  if (outcome === "failed") return { outcome: "failed", legacyUnverified: true };
  if (outcome === "completed-estimate") return { outcome: "completed", legacyUnverified: false };
  return { outcome, legacyUnverified: false };
}

/** What the summary LINE reads: duration, thinking, uncached I/O. The
 * persisted entry carries the cache amounts too (schema v2); the renderer
 * never displays them, so they are not part of its input contract. */
export interface SummaryLineSnapshot {
  elapsedMs: number;
  thinkingMs: number;
  usage: { input: number; output: number };
}

/** Build the summary line text (Codex grammar). Unknown pieces are omitted.
 * "Worked for" states the RUN ended normally — never business acceptance. */
export function formatSummaryLine(
  snapshot: SummaryLineSnapshot,
  outcome: InteractionOutcome,
  options: { legacyUnverified?: boolean } = {},
): string {
  const parts: string[] = [];
  const dur = formatDuration(snapshot.elapsedMs);
  if (options.legacyUnverified) {
    parts.push(`Ended after ${dur}`);
    parts.push("legacy status unverified");
  } else if (outcome === "interrupted") parts.push(`Interrupted after ${dur}`);
  else if (outcome === "failed") parts.push(`Failed after ${dur}`);
  else if (outcome === "incomplete") parts.push(`Ended after ${dur} · output limit`);
  else if (outcome === "unknown") parts.push(`Ended after ${dur}`);
  else parts.push(`Worked for ${dur}`);
  if (snapshot.thinkingMs > 0) parts.push(`thought for ${formatDuration(snapshot.thinkingMs)}`);
  const { input, output } = snapshot.usage;
  if (output > 0) parts.push(`↓${formatTokensCompact(output)}`);
  if (input > 0) parts.push(`↑${formatTokensCompact(input)}`);
  return parts.join(" · ");
}

/** A returned append call acknowledges host acceptance, not independent disk
 * durability. A throw may occur after the host accepted the entry in memory. */
export type SummaryAppendOutcome = "accepted" | "unconfirmed" | "unavailable";

export class TurnSummary {
  #deps: TurnSummaryDeps;
  /** Cache the append acknowledgement, including uncertain attempts. The host
   * may already hold an entry after a throw, so repetition must not reappend. */
  #appends = new Map<string, SummaryAppendOutcome>();

  constructor(deps: TurnSummaryDeps) {
    this.#deps = deps;
    this.#deps.registerEntryRenderer?.(SUMMARY_CUSTOM_TYPE, makeEntryRenderer());
  }

  /** Called from the metrics onSettled callback with the frozen verdict. */
  record(
    snapshot: InteractionSnapshot,
    verdict: {
      outcome: InteractionOutcome;
      evidence: TerminalEvidence;
      reason: string;
      attempt: number;
      toolErrorsObserved: number;
      replyEndedAt?: number;
    },
    branchAnchor?: string,
  ): SummaryAppendOutcome {
    const interactionId = `i${snapshot.startedAt ?? 0}`;
    const previous = this.#appends.get(interactionId);
    if (previous) return previous;
    this.#appends.set(interactionId, "unconfirmed");
    if (this.#appends.size > 32) {
      const first = this.#appends.keys().next().value;
      if (first !== undefined) this.#appends.delete(first);
    }

    const data: InteractionSummaryData = {
      schemaVersion: 2,
      interactionId,
      branchAnchor,
      startedAt: snapshot.startedAt ?? this.#deps.wall() - snapshot.elapsedMs,
      settledAt: this.#deps.wall(),
      elapsedMs: snapshot.elapsedMs,
      outcome: verdict.outcome,
      evidence: verdict.evidence,
      reason: verdict.reason,
      attempt: verdict.attempt,
      toolErrorsObserved: verdict.toolErrorsObserved,
    };
    if (verdict.replyEndedAt !== undefined) data.replyEndedAt = verdict.replyEndedAt;
    if (snapshot.thinkingMs > 0) data.thinkingMs = snapshot.thinkingMs;
    const u = snapshot.usage;
    if (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0) {
      data.usage = {};
      if (u.input > 0) data.usage.input = u.input;
      if (u.output > 0) data.usage.output = u.output;
      if (u.cacheRead > 0) data.usage.cacheRead = u.cacheRead;
      if (u.cacheWrite > 0) data.usage.cacheWrite = u.cacheWrite;
    }

    if (!this.#deps.persist || !this.#deps.appendEntry) {
      this.#appends.set(interactionId, "unavailable");
      return "unavailable";
    }
    try {
      this.#deps.appendEntry(SUMMARY_CUSTOM_TYPE, data);
      this.#appends.set(interactionId, "accepted");
      return "accepted";
    } catch {
      // Keep the uncertain receipt; the caller owns transient display delivery.
      return "unconfirmed";
    }
  }

  /** Reload/new session: old ids must not suppress new summaries. */
  forgetSession(): void {
    this.#appends.clear();
  }
}

export type SummaryEntryRendererDeps = {
  makeText: (text: string, paddingX?: number, paddingY?: number) => ComponentLike;
};

export interface ComponentLike {
  render(width: number): string[];
}

/** The renderer registered for our custom type. Handles v1 (legacy) and v2;
 * returns a small dim component — display copy only. */
export function makeEntryRenderer(makeText?: SummaryEntryRendererDeps["makeText"]) {
  return (entry: { customType: string; data?: unknown }, _options: unknown, theme?: { fg?: (k: string, t: string) => string }) => {
    const data = entry?.data as InteractionSummaryData | undefined;
    if (!data || (data.schemaVersion !== 1 && data.schemaVersion !== 2)) return undefined;
    const snapshot: SummaryLineSnapshot = {
      elapsedMs: data.elapsedMs,
      thinkingMs: data.thinkingMs ?? 0,
      usage: { input: data.usage?.input ?? 0, output: data.usage?.output ?? 0 },
    };
    const legacy = data.schemaVersion === 1
      ? legacyOutcome(data.outcome)
      : { outcome: data.outcome as InteractionOutcome, legacyUnverified: false };
    const line = formatSummaryLine(snapshot, legacy.outcome, { legacyUnverified: legacy.legacyUnverified });
    if (!line) return undefined;
    const timestamp = formatBeijingTime(data.replyEndedAt ?? data.settledAt);
    const lines = timestamp ? [line, timestamp] : [line];
    // The theme handed to entry renderers may be an unbound proxy (early
    // restore rendering) — resolve via the shared lazy probe.
    const painter = resolveThemePainter(theme);
    if (makeText) return makeText(lines.map((text) => painter("dim", text)).join("\n"));
    return {
      render: (width: number) => lines.map((text) => painter("dim", clipLine(text, width))),
      invalidate() {},
    };
  };
}
