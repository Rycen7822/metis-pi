import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { defaultMetisConfig } from "../metis-config.ts";
import type { ContextMetricsSnapshot } from "./types.ts";

// Ceiling on what the budget triggers treat as the context window. Advertised
// windows reach 1M, which makes any (0,1] fraction unreachable in a real session.
// The two triggers apply it in different shapes on purpose: the threshold is a
// LEVEL, so the cap bounds the level itself (min(CAP, threshold * window)); the
// delta is a GROWTH RATE, where a 300k ceiling could never bind, so the cap
// enters through the denominator instead (delta * min(window, CAP)).
export interface SummaryBudgetPolicy {
  maxBudgetWindowTokens: number; minGainTokens: number; minGainFraction: number; maxProxyTokens: number;
  targetBaseTokens: number; targetPerCallTokens: number; growthHeadroomTokens: number; nativeTargetTokens: number;
}
/** Defaults; runtime paths explicitly pass the validated current policy. */
export const SUMMARY_POLICY = defaultMetisConfig().contextPrune.summaryBudget as SummaryBudgetPolicy;
export const MAX_BUDGET_WINDOW = SUMMARY_POLICY.maxBudgetWindowTokens;

export function summaryBudget(before: number, fixed: number, calls: number, policy = SUMMARY_POLICY) {
  const minimumGain = Math.max(policy.minGainTokens, Math.ceil(policy.minGainFraction * before));
  return {
    minimumGain,
    limit: Math.min(policy.maxProxyTokens, Math.floor(before - fixed - minimumGain)),
    target: Math.min(policy.maxProxyTokens, policy.targetBaseTokens + policy.targetPerCallTokens * calls),
  };
}

/**
 * True iff a budget-triggered flush should fire: at `threshold` of the model's
 * window, MAX_BUDGET_WINDOW, or resolved native capacity minus growth headroom.
 * Computes the
 * level ourselves rather than using ContextUsage.percent (a 0–100 value, null
 * when tokens is null). tokens is also null right after a compaction — guarded here.
 */
export function shouldBudgetFlush(
  usage: ContextUsage | undefined,
  threshold: number | null,
  nativeCapacity?: number,
  policy = SUMMARY_POLICY,
): boolean {
  if (threshold == null || threshold <= 0 || threshold > 1) return false;
  if (!usage || usage.tokens == null || !Number.isFinite(usage.tokens) || !(usage.contextWindow > 0)) return false;
  const capacityGate = nativeCapacity !== undefined && Number.isFinite(nativeCapacity)
    ? Math.max(0, nativeCapacity - policy.growthHeadroomTokens) : Infinity;
  return usage.tokens >= Math.min(policy.maxBudgetWindowTokens, threshold * usage.contextWindow, capacityGate);
}

/**
 * Usage fraction against the effective window (min(contextWindow, MAX_BUDGET_WINDOW)),
 * or null when usage is missing / tokens null / window non-positive. NOT bounded by 1:
 * 600k tokens on a 1M window returns 2.0. Deliberately unclamped — clamping would make
 * shouldDeltaFlush saturate above the ceiling and stop re-arming.
 */
export function usageFraction(usage: ContextUsage | undefined, policy = SUMMARY_POLICY): number | null {
  if (!usage || usage.tokens == null || !(usage.contextWindow > 0)) return null;
  return usage.tokens / Math.min(usage.contextWindow, policy.maxBudgetWindowTokens);
}

/**
 * True iff this turn's usage fraction rose by at least `delta` versus the previous turn,
 * i.e. growth of at least `delta * min(contextWindow, MAX_BUDGET_WINDOW)` tokens.
 * Mirrors shouldBudgetFlush's guards. previousFraction === null (first turn or post-restart)
 * never fires; the absolute autoBudgetThreshold covers that gap.
 */
export function shouldDeltaFlush(
  usage: ContextUsage | undefined,
  previousFraction: number | null,
  delta: number | null,
  policy = SUMMARY_POLICY,
): boolean {
  if (delta == null || delta <= 0 || delta > 1) return false;
  if (previousFraction == null) return false;
  const current = usageFraction(usage, policy);
  if (current == null) return false;
  const window = Math.min(usage!.contextWindow, policy.maxBudgetWindowTokens);
  const previousTokens = previousFraction * window;
  const required = delta * window;
  const tokens = usage!.tokens!;
  const rounding = 4 * Number.EPSILON * Math.max(1, Math.abs(tokens), Math.abs(previousTokens), Math.abs(required));
  return tokens - previousTokens + rounding >= required;
}

/** Fail-closed: an undefined snapshot (metrics computation failed) never fires. */
export function shouldFrontierGapFlush(
  snapshot: ContextMetricsSnapshot | undefined,
  threshold: number | null,
): boolean {
  if (threshold == null) return false;
  return snapshot != null && snapshot.frontierGapTokens >= threshold;
}
