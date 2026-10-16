// Last completed text-generation rate. Observe each SDK stream BEFORE queueing,
// pair its completed message by object identity, and exclude reasoning/waiting.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface OutputSpeedSample {
  tokensPerSecond: number;
  outputTokens: number;
  windowMs: number;
  reasoningTokens: number;
  contentEvents: number;
}
interface ContentWindow {
  first?: number;
  last?: number;
  events: number;
  chars: number;
}
interface ProducerTiming { firstAt: number; windowMs: number; contentEvents: number }
export interface OutputTimingObserver {
  read(message: object): ProducerTiming | undefined;
  dispose(): void;
}

export const SPEED_LABEL = "gen(last)";
export const SPEED_UNIT = "tok/s";
export function computeSpeed(outputTokens: number, windowMs: number): number | undefined {
  if (!Number.isSafeInteger(outputTokens) || outputTokens <= 1) return undefined;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;
  const tps = (outputTokens - 1) / (windowMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : undefined;
}
export function formatSpeedValue(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  if (tps < 0.1) return Number(tps.toPrecision(2)).toString();
  return tps >= 100 ? `${Math.round(tps)}` : `${Math.round(tps * 10) / 10}`;
}
export function formatSpeed(tps: number | undefined): string {
  const value = formatSpeedValue(tps);
  return value ? `${SPEED_LABEL} ${value} ${SPEED_UNIT}` : "";
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
 * async consumers. Weak keys retain neither messages nor streams. No payloads
 * are copied, mutated, serialized or tokenized. Other wrappers are not removed. */
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
      if (!window || window.events < 2 || window.first === undefined || window.last === undefined) return;
      const final = record(message);
      if (final.stopReason !== "stop" && final.stopReason !== "length") return;
      const content = final.content;
      // A whole output count cannot be split between text and tool arguments.
      // Nor can unstreamed/backfilled text be timed by an earlier partial tail.
      if (!Array.isArray(content) || content.some(block => record(block).type !== "text" && record(block).type !== "thinking")) return;
      const chars = content.reduce((sum, block) => sum + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0);
      if (chars !== window.chars || window.last <= window.first) return;
      completed.set(message, { firstAt: window.first, windowMs: window.last - window.first, contentEvents: window.events });
    };
    const wrapper = function (this: object, event: unknown) {
      if (!installation?.users || record(this).done === true) return push.value.call(this, event);
      try {
        const value = record(event);
        if (value.type === "text_delta" && typeof value.delta === "string" && value.delta.length > 0) {
          const window = windows.get(this) ?? { events: 0, chars: 0 };
          const now = performance.now();
          window.first ??= now; window.last = now; window.events++; window.chars += value.delta.length;
          windows.set(this, window);
        } else if (value.type === "done") complete(this, value.message);
        else if (value.type === "error") {
          windows.delete(this);
          if (value.error !== null && typeof value.error === "object" && !completed.has(value.error)) completed.set(value.error, undefined);
        }
      } catch { /* Timing must never interfere with provider delivery. */ }
      return push.value.call(this, event);
    };
    const endWrapper = function (this: object, message?: unknown) {
      try { if (installation?.users && message !== undefined) complete(this, message); else windows.delete(this); } catch { /* best effort */ }
      return end.value.call(this, message);
    };
    installation = { users: 0, completed, release() {
      if (Reflect.get(prototype, "push") === wrapper) Object.defineProperty(prototype, "push", push);
      if (Reflect.get(prototype, "end") === endWrapper) Object.defineProperty(prototype, "end", end);
      if (Reflect.get(prototype, OWNER) === installation) Reflect.deleteProperty(prototype, OWNER);
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

export class OutputSpeedTracker {
  #openedAt: number | undefined;
  #sample: OutputSpeedSample | undefined;
  #readTiming: (message: object) => ProducerTiming | undefined;
  constructor(readTiming: (message: object) => ProducerTiming | undefined = () => undefined) { this.#readTiming = readTiming; }

  requestStart(): void { this.#openedAt = performance.now(); }
  finish(message: Record<string, unknown>): void {
    const openedAt = this.#openedAt;
    if (openedAt === undefined) return;
    this.#openedAt = undefined;
    if (message.stopReason !== "stop" && message.stopReason !== "length") return;
    const timing = this.#readTiming(message);
    if (!timing || timing.firstAt < openedAt) return;
    const usage = record(message.usage), content = message.content;
    const sawThinking = Array.isArray(content) && content.some(block => record(block).type === "thinking");
    // Undefined means unreported, not zero. Explicit off is safe only when no
    // thinking block was produced. Never divide hidden tokens by a text tail.
    const reasoning = usage.reasoning === undefined ? (message.thinkingLevel === "off" && !sawThinking ? 0 : undefined) : usage.reasoning;
    if (!Number.isSafeInteger(usage.output) || !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > usage.output) return;
    const tokens = usage.output - reasoning;
    const tps = computeSpeed(tokens, timing.windowMs);
    if (tps !== undefined) this.#sample = { tokensPerSecond: tps, outputTokens: tokens,
      windowMs: timing.windowMs, reasoningTokens: reasoning, contentEvents: timing.contentEvents };
  }
  snapshot(): OutputSpeedSample | undefined { return this.#sample; }
  clearSample(): void { this.#sample = undefined; }
  reset(): void { this.#openedAt = undefined; this.clearSample(); }
}
