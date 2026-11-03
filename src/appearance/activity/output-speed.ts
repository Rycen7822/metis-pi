import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";

interface GenerationCounts {
  estimatedTokens: number;
  durationMs: number;
}
/** A client-visible delivery estimate, not a server-side decoding benchmark. */
export interface OutputSpeedSample extends GenerationCounts {
  tokensPerSecond: number;
  sampleCount: number;
}
interface ResponseThroughput {
  outputTokens: number;
  durationMs: number;
  tokensPerSecond: number;
}
export const SPEED_LABEL = "gen≈(last)";
export const SPEED_UNIT = "tok/s";
export function computeSpeed(tokens: number, durationMs: number): number | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > Number.MAX_SAFE_INTEGER) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  const tps = tokens / (durationMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  if (tps < 0.1) return Number(tps.toPrecision(2)).toString();
  return tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
}
export function formatSpeedLabel(sampleCount = 1): string {
  return sampleCount > 1 ? `gen≈(avg${sampleCount})` : SPEED_LABEL;
}
export function formatSpeed(tps: number | undefined, sampleCount = 1): string {
  const value = formatSpeedValue(tps);
  return value ? `${formatSpeedLabel(sampleCount)} ${value} ${SPEED_UNIT}` : "";
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
// Short bodies pool at most three measured body windows, never full-response waits.
const SHORT_OUTPUT_TOKENS = 64;

export class OutputSpeedTracker {
  #requestStartedAt: number | undefined;
  #seen = new WeakSet<object>();
  #sample: OutputSpeedSample | undefined;
  #throughput: ResponseThroughput | undefined;
  #recent: GenerationCounts[] = [];
  #source: string | undefined;
  #timing: ReturnType<typeof observeTextOutput>;

  requestStart(): void {
    this.#timing ??= observeTextOutput();
    this.#requestStartedAt = Date.now();
  }
  textStart(): void {
    // Clearing is idempotent; no second flag needs to mirror whether a body has started.
    if (this.#requestStartedAt !== undefined) this.#sample = undefined;
  }
  finish(message: Record<string, unknown>): void {
    if (message.role !== "assistant" || this.#seen.has(message)) return;
    this.#seen.add(message);
    const startedAt = this.#requestStartedAt;
    if (startedAt === undefined) return;
    if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp < startedAt) return;
    this.#requestStartedAt = undefined;
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return;
    const usage = record(message.usage);
    if (!isCount(usage.output)) return;
    const durationMs = message.durationMs;
    const totalRate = typeof durationMs === "number" ? computeSpeed(usage.output, durationMs) : undefined;
    if (typeof durationMs === "number" && totalRate !== undefined)
      this.#throughput = { outputTokens: usage.output, durationMs, tokensPerSecond: totalRate };
    let hasThinking = false;
    for (const content of Array.isArray(message.content) ? message.content : []) {
      const block = record(content);
      if (block.type === "thinking") hasThinking = true;
      if (block.type === "text" && typeof block.text === "string" && block.text.length) this.#sample = undefined;
    }
    const timing = this.#timing?.read(message);
    // Undefined reasoning is unreported, not zero. Never estimate it from summaries or encrypted state.
    if (!timing || !isCount(usage.reasoning) || usage.reasoning > usage.output) return;
    // Some SDK adapters default an omitted breakdown to zero. A thinking block makes that zero ambiguous.
    if (usage.reasoning === 0 && hasThinking) return;
    const bodyTokens = usage.output - usage.reasoning;
    // First batches have no observable generation interval. Apportion only their successors' character share.
    const current: GenerationCounts = {
      estimatedTokens: bodyTokens * timing.timedChars / timing.chars,
      durationMs: timing.durationMs,
    };
    const tps = computeSpeed(current.estimatedTokens, current.durationMs);
    if (tps === undefined) return;
    const identity = [message.provider, message.api, message.model];
    const source = identity.every(value => typeof value === "string" && value.length > 0)
      ? JSON.stringify([...identity, ...[message.responseModel, message.thinkingLevel, message.providerThinkingLevel]
        .map(value => typeof value === "string" ? value : null)]) : undefined;
    if (source === undefined || source !== this.#source) this.#recent = [];
    this.#source = source;
    this.#recent.push(current);
    if (this.#recent.length > 3) this.#recent.shift();
    this.#sample = { ...current, tokensPerSecond: tps, sampleCount: 1 };
    if (bodyTokens > SHORT_OUTPUT_TOKENS || this.#recent.length === 1) return;
    const total = this.#recent.reduce((sum, sample) => ({
      estimatedTokens: sum.estimatedTokens + sample.estimatedTokens, durationMs: sum.durationMs + sample.durationMs,
    }), { estimatedTokens: 0, durationMs: 0 });
    const pooled = computeSpeed(total.estimatedTokens, total.durationMs);
    if (pooled === undefined) this.#recent = [current];
    else this.#sample = { ...total, tokensPerSecond: pooled, sampleCount: this.#recent.length };
  }
  snapshot(): OutputSpeedSample | undefined { return this.#sample; }
  throughput(): ResponseThroughput | undefined { return this.#throughput; }
  clearSample(): void { this.#sample = undefined; this.#throughput = undefined; this.#recent = []; this.#source = undefined; }
  reset(): void {
    this.#timing?.dispose();
    this.#timing = undefined;
    this.#requestStartedAt = undefined;
    this.clearSample();
  }
}


interface TextOutputTiming {
  chars: number;
  timedChars: number;
  durationMs: number;
}
interface TextWindow {
  timedChars: number;
  durationMs: number;
  lastAt?: number;
  batch?: ReturnType<typeof setImmediate>;
  timedBatch: boolean;
  blocks: Map<number, number>;
}
interface Installation {
  users: number;
  read(message: object): TextOutputTiming | undefined;
  release(): void;
}
const OWNER = Symbol.for("Rycen7822.metis-pi.text-output-timing");
// Sub-100ms samples mostly measure delivery/CPU jitter, not sustained generation.
const MIN_WINDOW_MS = 100;

/** Observe the SDK producer, not queued UI callbacks. Keep counts, never copies of text or encrypted thinking. */
function observeTextOutput() {
  const prototype = Object.getPrototypeOf(createAssistantMessageEventStream());
  // This symbol is written only by copies of this observer sharing the host SDK prototype.
  let installation = Object.getOwnPropertyDescriptor(prototype, OWNER)?.value as Installation | undefined;
  if (!installation) {
    const push = Object.getOwnPropertyDescriptor(prototype, "push");
    const end = Object.getOwnPropertyDescriptor(prototype, "end");
    if (!push?.configurable || !end?.configurable || typeof push.value !== "function" || typeof end.value !== "function"
      || !Object.isExtensible(prototype))
      return;
    // null marks a closed stream; undefined means no text has arrived.
    const windows = new WeakMap<object, TextWindow | null>();
    let completed = new WeakMap<object, TextOutputTiming | undefined>();
    let batch: ReturnType<typeof setImmediate> | undefined;
    const complete = (stream: object, message?: AssistantMessage) => {
      const window = windows.get(stream);
      if (window === null) return;
      windows.set(stream, null);
      if (!message || completed.has(message)) return;
      // Seal even an unmeasurable completion: a forwarding stream cannot retime it later.
      completed.set(message, undefined);
      if (!window || window.durationMs < MIN_WINDOW_MS) return;
      let blocks = 0;
      let chars = 0;
      for (const [index, block] of message.content.entries()) {
        if (block.type === "thinking") continue;
        if (block.type !== "text") return; // Non-reasoning usage also contains tool arguments in mixed responses.
        if (!block.text && !window.blocks.has(index)) continue;
        if (window.blocks.get(index) !== block.text.length) return; // Reject terminal-only backfills and incomplete delivery.
        blocks++;
        chars += block.text.length;
      }
      // Observe at least half the body after initial batches; don't extrapolate a tiny buffered tail.
      if (blocks !== window.blocks.size || window.timedChars * 2 < chars) return;
      completed.set(message, { chars, timedChars: window.timedChars, durationMs: window.durationMs });
    };
    const observe = (stream: object, event: AssistantMessageEvent) => {
      const existing = windows.get(stream);
      if (existing === null) return;
      if (event.type === "done") { complete(stream, event.message); return; }
      if (event.type === "error") { complete(stream); return; }
      if (event.type === "text_start" || event.type === "text_end"
        || event.type.startsWith("thinking_") || event.type.startsWith("toolcall_")) {
        if (existing) { existing.batch = undefined; existing.lastAt = undefined; }
        return;
      }
      if (event.type !== "text_delta" || !event.delta) return;
      const window: TextWindow = existing ?? { timedChars: 0, durationMs: 0, timedBatch: false, blocks: new Map() };
      if (!existing) windows.set(stream, window);
      // The pending immediate is the batch identity: synchronous/microtask deltas share one delivery.
      batch ??= setImmediate(() => { batch = undefined; }).unref();
      if (window.batch !== batch) {
        const now = performance.now();
        window.timedBatch = window.lastAt !== undefined;
        if (window.lastAt !== undefined) window.durationMs += now - window.lastAt;
        window.lastAt = now;
        window.batch = batch;
      }
      if (window.timedBatch) window.timedChars += event.delta.length;
      window.blocks.set(event.contentIndex, (window.blocks.get(event.contentIndex) ?? 0) + event.delta.length);
    };
    const wrapper = function (this: object, event: AssistantMessageEvent) {
      if (installation?.users) {
        try { observe(this, event); } catch { complete(this); } // Optional telemetry must not break provider delivery.
      }
      return push.value.call(this, event);
    };
    const endWrapper = function (this: object, message?: AssistantMessage) {
      if (installation?.users) {
        try { complete(this, message); } catch { complete(this); }
      }
      return end.value.call(this, message);
    };
    installation = { users: 0, read: message => completed.get(message), release() {
      if (batch) clearImmediate(batch);
      batch = undefined;
      completed = new WeakMap();
      if (Object.getOwnPropertyDescriptor(prototype, "push")?.value === wrapper)
        Reflect.defineProperty(prototype, "push", { ...push, value: push.value });
      if (Object.getOwnPropertyDescriptor(prototype, "end")?.value === endWrapper)
        Reflect.defineProperty(prototype, "end", { ...end, value: end.value });
      if (Object.getOwnPropertyDescriptor(prototype, OWNER)?.value === installation) Reflect.deleteProperty(prototype, OWNER);
    } };
    Object.defineProperty(prototype, "push", { ...push, value: wrapper });
    Object.defineProperty(prototype, "end", { ...end, value: endWrapper });
    Object.defineProperty(prototype, OWNER, { value: installation, configurable: true });
  }
  const installed = installation;
  installed.users++;
  let disposed = false;
  return {
    read: (message: object) => disposed ? undefined : installed.read(message),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--installed.users === 0) installed.release();
    },
  };
}
