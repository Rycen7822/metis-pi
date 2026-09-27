import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import type { ContextMetricsSnapshot } from "./types.js";
export declare const MAX_BUDGET_WINDOW = 300000;
/**
 * True iff a budget-triggered flush should fire: at `threshold` of the model's
 * window, or at MAX_BUDGET_WINDOW tokens, whichever comes first. Computes the
 * level ourselves rather than using ContextUsage.percent (a 0–100 value, null
 * when tokens is null). tokens is also null right after a compaction — guarded here.
 */
export declare function shouldBudgetFlush(usage: ContextUsage | undefined, threshold: number | null): boolean;
/**
 * Usage fraction against the effective window (min(contextWindow, MAX_BUDGET_WINDOW)),
 * or null when usage is missing / tokens null / window non-positive. NOT bounded by 1:
 * 600k tokens on a 1M window returns 2.0. Deliberately unclamped — clamping would make
 * shouldDeltaFlush saturate above the ceiling and stop re-arming.
 */
export declare function usageFraction(usage: ContextUsage | undefined): number | null;
/**
 * True iff this turn's usage fraction rose by at least `delta` versus the previous turn,
 * i.e. growth of at least `delta * min(contextWindow, MAX_BUDGET_WINDOW)` tokens.
 * Mirrors shouldBudgetFlush's guards. previousFraction === null (first turn or post-restart)
 * never fires; the absolute autoBudgetThreshold covers that gap.
 */
export declare function shouldDeltaFlush(usage: ContextUsage | undefined, previousFraction: number | null, delta: number | null): boolean;
/** Fail-closed: an undefined snapshot (metrics computation failed) never fires. */
export declare function shouldFrontierGapFlush(snapshot: ContextMetricsSnapshot | undefined, threshold: number | null): boolean;
