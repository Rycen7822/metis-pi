/** Session-scoped routing state; model IO and notifications stay in the caller. */
export const COOLDOWN_MS = 10 * 60 * 1000;
export type FallbackTransition = "enter" | "recover" | "none";

export interface TargetDecision {
  key: string;
  index: number;
  wasProbe: boolean;
}

export class FallbackController {
  private chainKey = "";
  private index = 0;
  private announcedIndex = 0;
  private lastProbeAt = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Claim a probe synchronously, before any await, so sibling calls skip it. */
  chooseTarget(key: string): TargetDecision {
    if (key !== this.chainKey) {
      this.chainKey = key;
      this.index = this.announcedIndex = this.lastProbeAt = 0;
    }
    const wasProbe = this.index > 0 && this.now() - this.lastProbeAt >= COOLDOWN_MS;
    if (wasProbe) this.lastProbeAt = this.now();
    return { key, index: wasProbe ? 0 : this.index, wasProbe };
  }

  /** An absent index means the attempted suffix of the chain was unavailable. */
  complete(decision: TargetDecision, index?: number): FallbackTransition {
    // Ignore stale chains and fallback calls finishing after primary recovery.
    if (decision.key !== this.chainKey || (decision.index > 0 && this.index === 0)) return "none";
    if (index === undefined) {
      if (decision.index === 0) {
        this.lastProbeAt = this.now();
        this.index ||= 1;
      }
      // A steady fallback failure must not postpone the next primary probe.
      return "none";
    }
    if (index === 0) {
      if (!decision.wasProbe || this.index === 0) return "none";
      this.index = this.announcedIndex = 0;
      return "recover";
    }
    if (decision.index === 0) this.lastProbeAt = this.now();
    this.index = index;
    const changed = this.announcedIndex !== index;
    this.announcedIndex = index;
    return changed ? "enter" : "none";
  }
}
