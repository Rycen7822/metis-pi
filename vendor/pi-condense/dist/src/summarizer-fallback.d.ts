/**
 * Session-scoped, in-memory state machine for summarizer-model outage fallback.
 *
 * Pure of model IO and notify plumbing: transition methods mutate state and
 * return a transition tag; the caller (runSummarization) performs the LLM runs
 * and emits any notify text. `now()` is injected for deterministic tests.
 *
 * Engaged ONLY on transient (outage-shaped) failures of the configured
 * summarizer model, and only when a distinct fallback model exists. Sticky:
 * once in fallback, all calls route to the session model until a single
 * per-cooldown probe of the primary succeeds. See
 * doc/specs/2026-07-06-summarizer-outage-fallback.md.
 */
/** Re-probe cooldown while in fallback. Internal; deliberately not configurable. */
export declare const COOLDOWN_MS: number;
export type FallbackTransition = "enter" | "recover" | "none";
export type CallTarget = "primary" | "fallback";
export interface TargetDecision {
    target: CallTarget;
    wasProbe: boolean;
}
/** Minimal structural view of a pi-ai Model (avoids the generic Api type param). */
export interface ModelLike {
    id: string;
    provider: string;
    name?: string;
}
export declare class FallbackController {
    private readonly now;
    inFallback: boolean;
    private lastProbeAt;
    private owedEnterWarning;
    constructor(now?: () => number);
    reset(): void;
    /**
     * True when primary and the session model are genuinely different. When
     * false the controller must NOT be consulted (behavior identical to today).
     * `Model.provider` is a plain string in pi-ai, not an object.
     */
    static hasDistinctFallback(primary: ModelLike | undefined, sessionModel: ModelLike | undefined): boolean;
    /**
     * Pick the model target for the next call and, if eligible, claim the single
     * per-cooldown probe. The claim is synchronous: the first of N concurrent
     * callers in a flush advances `lastProbeAt`, so siblings see the cooldown as
     * not elapsed and route to the fallback. Call before the first await.
     */
    chooseTarget(): TargetDecision;
    /** Primary (initial or probe) failed transiently but the fallback retry succeeded. */
    onPrimaryFailFallbackOk(_wasProbe: boolean): FallbackTransition;
    /** Both the primary call and the fallback retry failed transiently. */
    onBothDown(): void;
    /**
     * A steady-state fallback call (already in fallback) failed transiently.
     * Deliberately a no-op on `lastProbeAt`: a fallback failure is not a probe,
     * so it must not push out the next primary re-probe. Resetting the cooldown
     * here starves the probe whenever the fallback fails at least once per
     * COOLDOWN_MS, leaving a recovered primary undetected indefinitely.
     */
    onFallbackOnlyFail(): void;
    /** A primary call succeeded. Recover only when it was the probe. */
    onPrimarySuccess(wasProbe: boolean): FallbackTransition;
    /** A steady-state fallback call succeeded. Fire the deferred enter warning if owed. */
    onFallbackSuccess(): FallbackTransition;
}
