import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { OutputSpeedTracker, observeOutputTiming, computeSpeed, formatSpeed, formatSpeedValue } from "../../src/output-speed.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function fixture(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const observer = observeOutputTiming(); t.after(() => observer.dispose());
  const tracker = new OutputSpeedTracker(observer.read);
  const producer = (output = 41, reasoning: unknown = 0) => {
    const started = now;
    const message = { role: "assistant", provider: "p", api: "openai-responses", model: "m", responseId: "same-id",
      timestamp: Date.now(), stopReason: "stop", usage: { output, reasoning },
      content: [{ type: "text", text: "" }], durationMs: 100_000 } as unknown as AssistantMessage;
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
    return { message, stream,
      text(ms: number, delta: string) {
        now = started + ms; (message.content[0] as { text: string }).text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
      },
      done(endOnly = false) {
        if (endOnly) stream.end(message);
        else { stream.push({ type: "done", reason: "stop", message }); stream.end(); }
        return message;
      },
    };
  };
  return { observer, tracker, producer, tick: (ms: number) => { now += ms; } };
}

test("generation rate excludes initial wait and late completion callbacks", t => {
  const { tracker, producer, tick } = fixture(t);
  for (const wait of [0, 10_000]) {
    tracker.requestStart(); const p = producer();
    p.text(wait, "first"); p.text(wait + 400, "last"); p.done();
    tick(wait + 5000); tracker.finish(p.message as unknown as Record<string, unknown>);
    assert.deepEqual(tracker.snapshot(), { outputTokens: 41, windowMs: 400, tokensPerSecond: 100,
      reasoningTokens: 0, contentEvents: 2 });
  }
});

test("hidden reasoning is excluded; missing breakdown is not zero", t => {
  const { tracker, producer } = fixture(t);
  for (const reasoning of [1000, undefined, null, "0", -1, 1042, 1.5, NaN]) {
    tracker.reset(); tracker.requestStart(); const p = producer(1041);
    (p.message.usage as any).reasoning = reasoning;
    p.message.content.push({ type: "thinking", thinking: "summary", thinkingSignature: "opaque" });
    p.text(10_000, "first"); p.text(10_400, "last"); p.done();
    tracker.finish(p.message as unknown as Record<string, unknown>);
    assert.equal(tracker.snapshot()?.tokensPerSecond, reasoning === 1000 ? 100 : undefined);
  }
  for (const level of [undefined, "high", "off"]) {
    tracker.reset(); tracker.requestStart(); const p = producer();
    (p.message.usage as any).reasoning = undefined; (p.message as any).thinkingLevel = level;
    p.text(20_000, "first"); p.text(20_400, "last"); p.done(); tracker.finish(p.message as any);
    assert.equal(tracker.snapshot()?.tokensPerSecond, level === "off" ? 100 : undefined);
  }
});

test("single/buffered chunks, backfills, tool output and invalid completions preserve the previous valid rate", t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const previous = producer(); previous.text(10, "a"); previous.text(410, "b"); previous.done(); tracker.finish(previous.message as any);
  const sample = tracker.snapshot(); assert.ok(sample);
  for (const variant of ["one chunk", "same tick", "empty", "one token", "backfill", "tool", "error", "aborted", "deferred", "pending"]) {
    tracker.requestStart(); const p = producer(variant === "one token" ? 1 : 41);
    p.text(1000, variant === "empty" ? "" : "first");
    if (variant !== "one chunk") p.text(variant === "same tick" ? 1000 : 1400, variant === "empty" ? "" : "last");
    if (variant === "backfill") (p.message.content[0] as { text: string }).text += " unstreamed content";
    if (variant === "tool") p.message.content.push({ type: "toolCall", id: "t", name: "bash", arguments: {} });
    p.done();
    if (["error", "aborted", "deferred", "pending"].includes(variant)) (p.message as any).stopReason = variant;
    tracker.finish(p.message as any); assert.equal(tracker.snapshot(), sample, variant);
  }
});

test("overlapping warmers with identical IDs cannot contaminate the main stream, even across requests", t => {
  const { tracker, producer } = fixture(t);
  const a = producer(), warm = producer(), main = producer();
  a.text(10, "a"); warm.text(20, "warm"); a.text(30, "b"); a.done();
  tracker.requestStart(); // warmer already existed before this main request
  main.text(100, "first"); warm.text(200, "other"); warm.done();
  main.text(500, "last"); main.done(); tracker.finish(main.message as any);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 100, "pair by completed object, not last event/response ID");
});

test("reset rejects late samples; compaction preserves a pending slot; end(result) is measured", t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const stale = producer(); stale.text(100, "a"); stale.text(500, "b"); stale.done();
  tracker.reset(); tracker.finish(stale.message as any); assert.equal(tracker.snapshot(), undefined);
  tracker.requestStart(); tracker.clearSample(); tracker.finish(stale.message as any);
  assert.equal(tracker.snapshot(), undefined, "an earlier producer window cannot resurrect on the next request");
  tracker.requestStart(); tracker.clearSample(); const current = producer();
  current.text(1000, "a"); current.text(1400, "b"); current.message.stopReason = "length"; current.done(true);
  tracker.finish(current.message as any); assert.equal(tracker.snapshot()?.tokensPerSecond, 100);
});

test("forwarding cannot replace either a valid or an unmeasurable producer completion", t => {
  const { tracker, producer, tick } = fixture(t);
  for (const buffered of [true, false]) {
    tracker.reset(); tracker.requestStart(); const source = producer();
    source.text(100, "first"); source.text(buffered ? 100 : 500, "last"); source.done();
    const forwarded = createAssistantMessageEventStream();
    forwarded.push({ type: "start", partial: source.message });
    tick(1000); forwarded.push({ type: "text_delta", contentIndex: 0, delta: "first", partial: source.message });
    tick(1000); forwarded.push({ type: "text_delta", contentIndex: 0, delta: "last", partial: source.message });
    forwarded.push({ type: "done", reason: "stop", message: source.message }); forwarded.end();
    tracker.finish(source.message as any);
    assert.equal(tracker.snapshot()?.tokensPerSecond, buffered ? undefined : 100,
      "forwarding delay must not invent or replace a producer's measurement");
  }
});

test("shared instrumentation restores exact descriptors once, and leaves later wrappers intact", t => {
  const proto = Object.getPrototypeOf(createAssistantMessageEventStream());
  const beforePush = Object.getOwnPropertyDescriptor(proto, "push")!, beforeEnd = Object.getOwnPropertyDescriptor(proto, "end")!;
  const a = observeOutputTiming(), b = observeOutputTiming();
  t.after(() => { a.dispose(); b.dispose(); Object.defineProperty(proto, "push", beforePush); Object.defineProperty(proto, "end", beforeEnd); });
  a.dispose(); a.dispose(); assert.notEqual(proto.push, beforePush.value);
  b.dispose(); assert.deepEqual(Object.getOwnPropertyDescriptor(proto, "push"), beforePush);
  assert.deepEqual(Object.getOwnPropertyDescriptor(proto, "end"), beforeEnd);
  const c = observeOutputTiming(); const ours = proto.push;
  const later = function (this: AssistantMessageEventStream, ...args: Parameters<typeof ours>) { return ours.apply(this, args); };
  proto.push = later; c.dispose(); assert.equal(proto.push, later, "do not remove another extension's wrapper");
  const stream = createAssistantMessageEventStream(); stream.end();
});

for (const [tokens, ms, expected] of [
  [0, 10000, undefined], [1, 1000, undefined], [-1, 1000, undefined], [1.5, 1000, undefined],
  [NaN, 1000, undefined], [Number.MAX_SAFE_INTEGER + 1, 1000, undefined], [10, NaN, undefined],
  [10, Infinity, undefined], [10, -1, undefined], [10, 0, undefined], [10, Number.MIN_VALUE, undefined],
  [2, 60000, 1 / 60], [3, 4000, 0.5], [4, 300, 10], [5002, 1000, 5001],
] as const) {
  test(`generation arithmetic: ${tokens} tokens in ${ms}ms after the first token`, () => assert.equal(computeSpeed(tokens, ms), expected));
}

test("formatting identifies generation scope and never rounds a measured slow rate to zero", () => {
  assert.equal(formatSpeed(38.54), "gen(last) 38.5 tok/s");
  assert.equal(formatSpeed(123.4), "gen(last) 123 tok/s");
  assert.equal(formatSpeed(1 / 60), "gen(last) 0.017 tok/s");
  assert.equal(formatSpeedValue(1e-9), "1e-9");
  for (const rate of [undefined, NaN, Infinity, -1, 0]) assert.equal(formatSpeed(rate), "");
});
