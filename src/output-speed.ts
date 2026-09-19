// Observed model output speed (tokens/s) for the composer footer.
//
// Scope discipline (same as every other displayed number): ONE sample per
// assistant response, always
//     output tokens ÷ observed output window
// with both terms REAL — never a character estimate, never a provider claim:
//   • tokens — the host's confirmed `usage.output` of that assistant message
//     (mid-stream, the provider's own CUMULATIVE count, which replaces itself);
//   • window — first→last streamed content delta of that message, i.e. the
//     time the model actually spent emitting tokens (TTFT excluded), or the
//     assistant `message_start`→`message_end` span when the delta window is
//     missing/degenerate (non-streaming or batched delivery).
// While a response streams, the SAME formula runs live when the provider
// publishes cumulative output tokens mid-stream (Anthropic-style
// message_delta). OpenAI-compatible providers report usage only in the final
// chunk, so there the value appears at message_end and then persists until a
// newer response replaces it. Unmeasurable responses (no confirmed output
// tokens, window too short to be meaningful, implausible rate) display
// NOTHING — no placeholder, no estimate, no 0.

export interface OutputSpeedSample {
  tokensPerSecond: number;
  outputTokens: number;
  /** Real observation window the rate was computed over, ms. */
  windowMs: number;
  /** "live" = in-flight response (streamed cumulative usage), "final" =
   * confirmed at message_end. */
  scope: "live" | "final";
}

/** Below this the window says nothing about a rate (one batched delta). */
export const SPEED_MIN_WINDOW_MS = 300;
/** A response with no confirmed output tokens has no speed to report. */
const SPEED_MIN_TOKENS = 1;
/** Sanity rails: outside these the sample is a measurement artifact rather
 * than a rate — below the floor a response emits less than one token per 10 s
 * (a stall, not a speed to display), above the ceiling it is a clock bug. */
const SPEED_MIN_PLAUSIBLE = 0.1;
export const SPEED_MAX_PLAUSIBLE = 5000;

export const SPEED_UNIT = "tok/s";

/** Real rate or undefined — the single place the ratio is decided. */
export function computeSpeed(outputTokens: number, windowMs: number): number | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens < SPEED_MIN_TOKENS) return undefined;
  if (!Number.isFinite(windowMs) || windowMs < SPEED_MIN_WINDOW_MS) return undefined;
  const tps = outputTokens / (windowMs / 1000);
  if (!Number.isFinite(tps) || tps < SPEED_MIN_PLAUSIBLE || tps > SPEED_MAX_PLAUSIBLE) return undefined;
  return tps;
}

/** Numeric part only ("38.5" / "123"); "" when unmeasurable — including a
 * rate that would round to "0" (a zero cell is a fabricated zero). */
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  const text = tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
  return text === "0" ? "" : text;
}

/** Full label ("38.5 tok/s"); "" when unmeasurable. */
export function formatSpeed(tps: number | undefined): string {
  const value = formatSpeedValue(tps);
  return value ? `${value} ${SPEED_UNIT}` : "";
}

export interface OutputSpeedOptions {
  /** Monotonic clock (same source as the interaction metrics). */
  now: () => number;
}

/** Per-response timing window. One instance per session; display data only. */
export class OutputSpeedTracker {
  readonly #now: () => number;
  #requestStartMs: number | undefined;
  #outputStartMs: number | undefined;
  #lastDeltaMs: number | undefined;
  #previewTokens = 0;
  #last: OutputSpeedSample | undefined;

  constructor(options: OutputSpeedOptions) {
    this.#now = options.now;
  }

  /** assistant message_start: a new response window opens. */
  requestStart(): void {
    this.#requestStartMs = this.#now();
    this.#outputStartMs = undefined;
    this.#lastDeltaMs = undefined;
    this.#previewTokens = 0;
  }

  /** A streamed content delta of the in-flight response (thinking, text or
   * tool-call arguments — all of them are model output). */
  delta(): void {
    if (this.#requestStartMs === undefined) return;
    const nowMs = this.#now();
    this.#outputStartMs ??= nowMs;
    this.#lastDeltaMs = nowMs;
  }

  /** Cumulative output tokens of the in-flight response. Returns true when
   * the count advanced — i.e. when a live frame is worth requesting. */
  preview(outputTokens: number): boolean {
    if (this.#requestStartMs === undefined) return false;
    const next = Number.isFinite(outputTokens) ? Math.max(0, Math.floor(outputTokens)) : 0;
    if (next <= this.#previewTokens) return false;
    this.#previewTokens = next;
    return true;
  }

  /** message_end: the host's confirmed output count closes the window. A
   * message without confirmed output tokens records nothing (the previous
   * sample stays); the live window is dropped either way, so a stale partial
   * can never outlive its response. */
  finish(outputTokens: number): void {
    if (this.#requestStartMs === undefined) return;
    const endMs = this.#now();
    const tokens = Number.isFinite(outputTokens) ? Math.floor(outputTokens) : 0;
    if (tokens >= SPEED_MIN_TOKENS) {
      const deltaWindow = this.#outputStartMs !== undefined && this.#lastDeltaMs !== undefined
        ? this.#lastDeltaMs - this.#outputStartMs
        : undefined;
      const windowMs = deltaWindow !== undefined && deltaWindow >= SPEED_MIN_WINDOW_MS
        ? deltaWindow
        : endMs - this.#requestStartMs;
      const tps = computeSpeed(tokens, windowMs);
      if (tps !== undefined) this.#last = { tokensPerSecond: tps, outputTokens: tokens, windowMs, scope: "final" };
    }
    this.#requestStartMs = undefined;
    this.#outputStartMs = undefined;
    this.#lastDeltaMs = undefined;
    this.#previewTokens = 0;
  }

  /** Live sample when the provider publishes cumulative output mid-stream. */
  #liveSample(): OutputSpeedSample | undefined {
    if (this.#requestStartMs === undefined || this.#outputStartMs === undefined) return undefined;
    if (this.#previewTokens < SPEED_MIN_TOKENS) return undefined;
    const windowMs = this.#now() - this.#outputStartMs;
    const tps = computeSpeed(this.#previewTokens, windowMs);
    if (tps === undefined) return undefined;
    return { tokensPerSecond: tps, outputTokens: this.#previewTokens, windowMs, scope: "live" };
  }

  /** The number the footer shows: the in-flight rate when one is available,
   * otherwise the last confirmed response's rate. */
  snapshot(): OutputSpeedSample | undefined {
    return this.#liveSample() ?? this.#last;
  }

  /** Session shutdown/reload: nothing survives. */
  reset(): void {
    this.#requestStartMs = undefined;
    this.#outputStartMs = undefined;
    this.#lastDeltaMs = undefined;
    this.#previewTokens = 0;
    this.#last = undefined;
  }
}
