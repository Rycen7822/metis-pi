// Completed model output throughput over the SDK's full response time, including reasoning.
// Native durationMs owns request timing; transport chunks never define the window.

interface ResponseCounts {
  outputTokens: number;
  durationMs: number;
  /** Breakdown of outputTokens, not an extra count. Undefined means unreported. */
  reasoningTokens: number | undefined;
}
/** Counts and duration cover the same complete responses, including pooled samples. */
export interface OutputSpeedSample extends ResponseCounts {
  tokensPerSecond: number;
  sampleCount: number;
}

export const SPEED_LABEL = "out(last)";
export const SPEED_UNIT = "tok/s";
export function computeSpeed(outputTokens: number, durationMs: number): number | undefined {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const tps = outputTokens / (durationMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  if (tps < 0.1) return Number(tps.toPrecision(2)).toString();
  return tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
}
export function formatSpeedLabel(sampleCount = 1): string {
  return sampleCount > 1 ? `out(avg${sampleCount})` : SPEED_LABEL;
}
export function formatSpeed(tps: number | undefined, sampleCount = 1): string {
  const value = formatSpeedValue(tps);
  return value ? `${formatSpeedLabel(sampleCount)} ${value} ${SPEED_UNIT}` : "";
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Short total outputs have noisy per-request throughput; pool at most three full responses.
const SHORT_OUTPUT_TOKENS = 64;

export class OutputSpeedTracker {
  // Wall time is only a stale-response guard. The SDK's monotonic clock owns duration.
  #requestStartedAt: number | undefined;
  #seen = new WeakSet<object>();
  #sample: OutputSpeedSample | undefined;
  #recent: ResponseCounts[] = [];
  #source: string | undefined;

  requestStart(): void { this.#requestStartedAt = Date.now(); }

  finish(message: Record<string, unknown>): void {
    if (message.role !== "assistant" || this.#seen.has(message)) return;
    this.#seen.add(message);
    const startedAt = this.#requestStartedAt;
    if (startedAt === undefined) return;
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp < startedAt) return;
    this.#requestStartedAt = undefined;
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return;
    const durationMs = message.durationMs;
    if (typeof durationMs !== "number") return;
    const usage = record(message.usage);
    if (!isTokenCount(usage.output)) return;
    const reasoning = usage.reasoning;
    if (reasoning !== undefined && (!isTokenCount(reasoning) || reasoning > usage.output)) return;
    // Unified SDK output already includes reasoning. Never add or subtract it again.
    const tokens = usage.output;
    const tps = computeSpeed(tokens, durationMs);
    if (tps === undefined) return;
    const current: ResponseCounts = { outputTokens: tokens, durationMs, reasoningTokens: reasoning };
    // Actual routing can change without a UI selection event. Unknown identity stays unpooled.
    const identity = [message.provider, message.api, message.model];
    const source = identity.every(value => typeof value === "string" && value.length > 0)
      ? JSON.stringify([...identity, ...[message.reportedModel, message.thinkingLevel].map(value => typeof value === "string" ? value : null)])
      : undefined;
    if (source === undefined || source !== this.#source) this.#recent = [];
    this.#source = source;
    this.#recent.push(current);
    if (this.#recent.length > 3) this.#recent.shift();
    this.#sample = { ...current, tokensPerSecond: tps, sampleCount: 1 };
    if (tokens > SHORT_OUTPUT_TOKENS || this.#recent.length === 1) return;
    const total: ResponseCounts = { outputTokens: 0, durationMs: 0, reasoningTokens: 0 };
    for (const sample of this.#recent) {
      total.outputTokens += sample.outputTokens;
      total.durationMs += sample.durationMs;
      total.reasoningTokens = total.reasoningTokens !== undefined && sample.reasoningTokens !== undefined
        ? total.reasoningTokens + sample.reasoningTokens : undefined;
    }
    const pooled = computeSpeed(total.outputTokens, total.durationMs);
    if (pooled === undefined) this.#recent = [current];
    else this.#sample = { ...total, tokensPerSecond: pooled, sampleCount: this.#recent.length };
  }

  snapshot(): OutputSpeedSample | undefined { return this.#sample; }
  clearSample(): void { this.#sample = undefined; this.#recent = []; this.#source = undefined; }
  reset(): void { this.#requestStartedAt = undefined; this.clearSample(); }
}
