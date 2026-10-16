// Per-response average output rate for the footer. Pair complete usage.output
// (including hidden reasoning and tool-call arguments) with the SDK's monotonic
// producer durationMs. This includes waiting/TTFT, not just token decoding.
// Consumer callback times, visible deltas and partial usage cannot measure the
// same interval reliably; missing producer timing therefore means no sample.

export interface OutputSpeedSample {
  tokensPerSecond: number;
  outputTokens: number;
  windowMs: number;
}

export const SPEED_LABEL = "avg";
export const SPEED_UNIT = "tok/s";

export function computeSpeed(outputTokens: number, windowMs: number): number | undefined {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) return undefined;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;
  const tps = outputTokens / (windowMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}

/** Numeric part only; very slow measured rates must not round to zero. */
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  if (tps < 0.1) return Number(tps.toPrecision(2)).toString();
  return tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
}

export function formatSpeed(tps: number | undefined): string {
  const value = formatSpeedValue(tps);
  return value ? `${SPEED_LABEL} ${value} ${SPEED_UNIT}` : "";
}

/** A turn owns at most one completed sample. Settings changes cancel an open
 * slot; a late response under the old selection must not reopen it. */
export class OutputSpeedTracker {
  #pending = false;
  #sample: OutputSpeedSample | undefined;

  /** Open the next response slot while retaining the last completed average. */
  requestStart(): void {
    this.#pending = true;
  }

  finish(outputTokens: unknown, durationMs: unknown, stopReason: unknown): void {
    if (!this.#pending) return;
    this.#pending = false;
    if (stopReason !== "stop" && stopReason !== "toolUse" && stopReason !== "length") return;
    if (typeof outputTokens !== "number" || typeof durationMs !== "number") return;
    const tps = computeSpeed(outputTokens, durationMs);
    if (tps !== undefined) this.#sample = {
      tokensPerSecond: tps, outputTokens, windowMs: durationMs,
    };
  }

  snapshot(): OutputSpeedSample | undefined {
    return this.#sample;
  }

  /** Compaction drops the old display sample, but may precede this turn's
   * provider request. Preserve its slot (including an earlier cancellation). */
  clearSample(): void {
    this.#sample = undefined;
  }

  reset(): void {
    this.#pending = false;
    this.clearSample();
  }
}
