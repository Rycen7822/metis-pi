// Completed non-reasoning generation rates, with bounded short-response smoothing.
// Observe SDK producers before queueing and pair completion by message identity.
import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

interface GenerationCounts {
  outputTokens: number;
  windowMs: number;
  reasoningTokens: number;
  contentEvents: number;
}
/** Counts/time cover the same windows as the displayed rate; more than one means pooled. */
export interface OutputSpeedSample extends GenerationCounts {
  tokensPerSecond: number;
  sampleCount: number;
}
type ContentCoverage = { type: "text"; chars: number } | { type: "toolCall"; json: string };
interface ContentWindow {
  first?: number;
  last?: number;
  events: number;
  blocks: Map<number, ContentCoverage>;
  invalid?: boolean;
}
interface ProducerTiming { firstAt: number; windowMs: number; contentEvents: number }
export interface OutputTimingObserver {
  read(message: object): ProducerTiming | undefined;
  dispose(): void;
}

export const SPEED_LABEL = "gen(last)";
export const SPEED_UNIT = "tok/s";
export function computeSpeed(outputTokens: number, windowMs: number, sampleCount = 1): number | undefined {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) return undefined;
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= sampleCount) return undefined;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;
  const tps = (outputTokens - sampleCount) / (windowMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  if (tps < 0.1) return Number(tps.toPrecision(2)).toString();
  return tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
}
export function formatSpeedLabel(sampleCount = 1): string {
  return sampleCount > 1 ? `gen(avg${sampleCount})` : SPEED_LABEL;
}
export function formatSpeed(tps: number | undefined, sampleCount = 1): string {
  const value = formatSpeedValue(tps);
  return value ? `${formatSpeedLabel(sampleCount)} ${value} ${SPEED_UNIT}` : "";
}

const OWNER = Symbol.for("Rycen7822.metis-pi.output-timing");
const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
interface Installation {
  users: number;
  completed: WeakMap<object, ProducerTiming | undefined>;
  release(): void;
}

/** Transparent, reference-counted instrumentation of the SDK producer, not its
 * async consumers. Weak keys retain neither messages nor streams. Tool argument
 * fragments are held only until completion to verify coverage; messages are not
 * mutated or tokenized. Other wrappers are not removed. */
export function observeOutputTiming(prototype: object = Object.getPrototypeOf(createAssistantMessageEventStream())): OutputTimingObserver {
  let installation = (prototype as Record<symbol, Installation>)[OWNER];
  if (!installation) {
    const push = Object.getOwnPropertyDescriptor(prototype, "push");
    const end = Object.getOwnPropertyDescriptor(prototype, "end");
    if (!push?.writable || !push.configurable || typeof push.value !== "function"
      || !end?.writable || !end.configurable || typeof end.value !== "function" || !Object.isExtensible(prototype)) {
      return { read: () => undefined, dispose() {} };
    }
    const windows = new WeakMap<object, ContentWindow>();
    const completed = new WeakMap<object, ProducerTiming | undefined>();
    const complete = (stream: object, message: unknown) => {
      const window = windows.get(stream);
      windows.delete(stream);
      if (message === null || typeof message !== "object" || completed.has(message)) return;
      // Presence seals even an unmeasurable first completion. Forwarding must
      // not replace it with delivery delays; only this producer may fill it.
      completed.set(message, undefined);
      if (!window || window.invalid || window.events < 2 || window.first === undefined || window.last === undefined) return;
      const final = record(message);
      if (final.stopReason !== "stop" && final.stopReason !== "length" && final.stopReason !== "toolUse") return;
      const content = final.content;
      if (!Array.isArray(content) || window.last <= window.first) return;
      let blocks = 0;
      for (const [index, block] of content.entries()) {
        const value = record(block);
        if (value.type === "thinking") continue;
        const seen = window.blocks.get(index);
        if (!seen && value.type === "text" && value.text === "") continue;
        if (!seen || seen.type !== value.type) return;
        if (seen.type === "text") {
          if (typeof value.text !== "string" || value.text.length !== seen.chars) return;
        } else {
          // Compare parsed arguments, not serialized length: providers may
          // normalize whitespace or key order. Missing/backfilled data is not timed.
          if (value.argumentsError || !isDeepStrictEqual(JSON.parse(seen.json), value.arguments)) return;
        }
        blocks++;
      }
      if (blocks !== window.blocks.size) return;
      completed.set(message, { firstAt: window.first, windowMs: window.last - window.first, contentEvents: window.events });
    };
    const observeContent = (stream: object, value: Record<string, any>) => {
      const type = value.type === "text_delta" ? "text"
        : value.type === "toolcall_delta" || value.type === "toolcall_start" ? "toolCall" : undefined;
      if (!type || !Number.isSafeInteger(value.contentIndex) || value.contentIndex < 0) return;
      const delta = typeof value.delta === "string" ? value.delta : "";
      if (value.type === "toolcall_start") {
        const block = record(record(value.partial).content?.[value.contentIndex]);
        if (typeof block.name !== "string" || !block.name) return;
      } else if (!delta) return;
      const window = windows.get(stream) ?? { events: 0, blocks: new Map<number, ContentCoverage>() };
      windows.set(stream, window);
      const seen = window.blocks.get(value.contentIndex) ?? (type === "text" ? { type, chars: 0 } : { type, json: "" });
      if (seen.type !== type) { window.invalid = true; return; }
      window.blocks.set(value.contentIndex, seen);
      const now = performance.now();
      window.first ??= now;
      if (!delta) return; // A name may arrive first, but it is not an argument delta.
      window.last = now; window.events++;
      if (seen.type === "text") seen.chars += delta.length;
      else seen.json += delta;
    };
    const wrapper = function (this: object, event: unknown) {
      if (!installation?.users || record(this).done === true) return push.value.call(this, event);
      try {
        const value = record(event);
        if (value.type === "done") complete(this, value.message);
        else if (value.type === "error") {
          windows.delete(this);
          if (value.error !== null && typeof value.error === "object" && !completed.has(value.error)) completed.set(value.error, undefined);
        } else observeContent(this, value);
      } catch { /* Timing must never interfere with provider delivery. */ }
      return push.value.call(this, event);
    };
    const endWrapper = function (this: object, message?: unknown) {
      try { if (installation?.users && message !== undefined) complete(this, message); else windows.delete(this); } catch { /* best effort */ }
      return end.value.call(this, message);
    };
    installation = { users: 0, completed, release() {
      const currentPush = Object.getOwnPropertyDescriptor(prototype, "push");
      const currentEnd = Object.getOwnPropertyDescriptor(prototype, "end");
      if (currentPush?.value === wrapper) Reflect.defineProperty(prototype, "push", { ...currentPush, value: push.value });
      if (currentEnd?.value === endWrapper) Reflect.defineProperty(prototype, "end", { ...currentEnd, value: end.value });
      if (Object.getOwnPropertyDescriptor(prototype, OWNER)?.value === installation) Reflect.deleteProperty(prototype, OWNER);
    } };
    Object.defineProperty(prototype, "push", { ...push, value: wrapper });
    Object.defineProperty(prototype, "end", { ...end, value: endWrapper });
    Object.defineProperty(prototype, OWNER, { value: installation, configurable: true });
  }
  installation.users++;
  let disposed = false;
  return {
    read: message => disposed ? undefined : installation.completed.get(message),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (--installation.users === 0) installation.release();
    },
  };
}

// A display heuristic, not a service-side decoding guarantee. Larger responses
// stand on their own; short responses pool the current and two prior valid windows.
const SHORT_OUTPUT_TOKENS = 64;

export class OutputSpeedTracker {
  #openedAt: number | undefined;
  #sample: OutputSpeedSample | undefined;
  #recent: GenerationCounts[] = [];
  #source: string | undefined;
  #readTiming: (message: object) => ProducerTiming | undefined;
  constructor(readTiming: (message: object) => ProducerTiming | undefined = () => undefined) { this.#readTiming = readTiming; }

  requestStart(): void { this.#openedAt = performance.now(); }
  finish(message: Record<string, unknown>): void {
    const openedAt = this.#openedAt;
    if (openedAt === undefined) return;
    this.#openedAt = undefined;
    if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") return;
    const timing = this.#readTiming(message);
    if (!timing || timing.firstAt < openedAt) return;
    const usage = record(message.usage), content = message.content;
    const sawThinking = Array.isArray(content) && content.some(block => record(block).type === "thinking");
    // Undefined means unreported, not zero. Explicit off is safe only when no
    // thinking block was produced. Never divide hidden tokens by a content tail.
    const reasoning = usage.reasoning === undefined ? (message.thinkingLevel === "off" && !sawThinking ? 0 : undefined) : usage.reasoning;
    if (!Number.isSafeInteger(usage.output) || !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > usage.output) return;
    const tokens = usage.output - reasoning;
    const tps = computeSpeed(tokens, timing.windowMs);
    if (tps === undefined) return;
    const current: GenerationCounts = { outputTokens: tokens, windowMs: timing.windowMs,
      reasoningTokens: reasoning, contentEvents: timing.contentEvents };
    // Routing can change the actual model without a UI model_select event.
    // Unknown identity may be measured alone, but cannot authorize calibration.
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
    const total: GenerationCounts = { outputTokens: 0, windowMs: 0, reasoningTokens: 0, contentEvents: 0 };
    for (const sample of this.#recent) {
      total.outputTokens += sample.outputTokens;
      total.windowMs += sample.windowMs;
      total.reasoningTokens += sample.reasoningTokens;
      total.contentEvents += sample.contentEvents;
    }
    // Pool raw counts/time, never already-smoothed rates. Each response has its
    // own first token outside its measured window, so subtract one per response.
    const pooled = computeSpeed(total.outputTokens, total.windowMs, this.#recent.length);
    if (pooled === undefined) this.#recent = [current]; // Pooled counters can overflow; keep the valid current result.
    else this.#sample = { ...total, tokensPerSecond: pooled, sampleCount: this.#recent.length };
  }
  snapshot(): OutputSpeedSample | undefined { return this.#sample; }
  clearSample(): void { this.#sample = undefined; this.#recent = []; this.#source = undefined; }
  reset(): void { this.#openedAt = undefined; this.clearSample(); }
}
