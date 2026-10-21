import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { OutputSpeedTracker, observeOutputTiming, computeSpeed, formatSpeed, formatSpeedValue } from "../../src/appearance/activity/output-speed.ts";
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
    const argumentsByIndex = new Map<number, string>();
    return { message, stream,
      text(ms: number, delta: string) {
        now = started + ms; (message.content[0] as { text: string }).text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
      },
      tool(ms: number, delta: string, index = 0, name = "bash") {
        now = started + ms;
        if (message.content[index]?.type !== "toolCall") {
          message.content[index] = { type: "toolCall", id: `tool-${index}`, name, arguments: {} };
          stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
        }
        const block = message.content[index] as Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
        const json = (argumentsByIndex.get(index) ?? "") + delta;
        argumentsByIndex.set(index, json);
        try { block.arguments = JSON.parse(json); } catch { /* Incomplete JSON is normal mid-stream. */ }
        message.stopReason = "toolUse";
        stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: message });
      },
      done(endOnly = false) {
        if (endOnly) stream.end(message);
        else { stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message }); stream.end(); }
        return message;
      },
    };
  };
  return { observer, tracker, producer, tick: (ms: number) => { now += ms; } };
}

test("generation rate excludes initial wait and late completion callbacks", t => {
  const { tracker, producer, tick } = fixture(t);
  for (const wait of [0, 10_000]) {
    tracker.reset(); tracker.requestStart(); const p = producer();
    p.text(wait, "first"); p.text(wait + 400, "last"); p.done();
    tick(wait + 5000); tracker.finish(p.message as unknown as Record<string, unknown>);
    assert.deepEqual(tracker.snapshot(), { outputTokens: 41, windowMs: 400, tokensPerSecond: 100,
      reasoningTokens: 0, contentEvents: 2, sampleCount: 1 });
  }
});

test("tool and mixed responses update per completion and recover after connection errors", t => {
  const { tracker, producer, tick } = fixture(t);
  tracker.requestStart();
  const first = producer(1041, 1000);
  first.tool(10_000, '{ "command":');
  first.tool(10_400, '"echo ready" }');
  first.done(); tick(5000); tracker.finish(first.message as any);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 100, "tool arguments use their own generation window, not whole-request duration");
  const previous = tracker.snapshot();
  tracker.requestStart();
  const failed = producer(0);
  failed.message.stopReason = "error"; failed.message.content = [];
  failed.stream.push({ type: "error", reason: "error", error: failed.message }); failed.stream.end();
  tracker.finish(failed.message as any);
  assert.equal(tracker.snapshot(), previous, "connection errors do not remove the previous tool response rate");
  tracker.requestStart();
  const retry = producer(161);
  retry.text(5000, "prefix");
  retry.tool(5400, '{"command":', 1);
  retry.tool(5800, '"echo retry"}', 1);
  retry.done(); tracker.finish(retry.message as any);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 200, "mixed text and tool arguments update before the overall task settles");
  assert.notEqual(tracker.snapshot(), previous);
});

test("parallel tool arguments tolerate empty text slots and reject incomplete backfills", t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const first = producer(41);
  first.tool(1000, '{"a":', 1); first.tool(1100, '{"b":', 2);
  first.tool(1300, '1}', 1); first.tool(1400, '2}', 2);
  first.done(); tracker.finish(first.message as any);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 100);
  const previous = tracker.snapshot();
  for (const variant of ["backfill", "invalid JSON", "omitted block"]) {
    tracker.requestStart(); const p = producer();
    p.tool(2000, '{"a":'); p.tool(2400, variant === "invalid JSON" ? "bad}" : "1}");
    const block = p.message.content[0] as any;
    if (variant === "backfill") block.arguments = { a: 1, unstreamed: true };
    if (variant === "omitted block") p.message.content = [];
    p.done(); tracker.finish(p.message as any);
    assert.equal(tracker.snapshot(), previous, variant);
  }
});

test("short responses pool the current and prior two valid windows, without averaging prior averages", t => {
  const { tracker, producer } = fixture(t);
  const complete = (output: number, ms: number, reasoning = 0) => {
    tracker.requestStart(); const p = producer(output, reasoning);
    p.text(5000, "first"); p.text(5000 + ms, "last"); p.done(); tracker.finish(p.message as any);
    return tracker.snapshot()!;
  };
  for (const ms of [10, 1000]) {
    tracker.reset();
    complete(1001, 10_000); complete(501, 5000); // Both have 100 tok/s generation rates.
    const previous = tracker.snapshot();
    tracker.requestStart(); const failed = producer(0);
    failed.message.stopReason = "error";
    failed.stream.push({ type: "error", reason: "error", error: failed.message }); failed.stream.end();
    tracker.finish(failed.message as any);
    assert.equal(tracker.snapshot(), previous);
    const short = complete(1005, ms, 1000); // Only five non-reasoning output tokens.
    assert.equal(short.tokensPerSecond, 1504 / (15 + ms / 1000));
    assert.equal(short.sampleCount, 3, "a failed response does not displace valid history");
    assert.equal(short.outputTokens, 1507);
    assert.equal(short.windowMs, 15_000 + ms);
    assert.equal(short.reasoningTokens, 1000);
    const next = complete(5, 400);
    assert.equal(next.tokensPerSecond, 508 / (5 + ms / 1000 + 0.4), "evict the oldest raw sample, not feed the prior average back in");
    assert.equal(next.sampleCount, 3);
  }
});

test("only outputs up to 64 non-reasoning tokens use history; longer responses remain current", t => {
  const { tracker, producer } = fixture(t);
  for (const tokens of [64, 65]) {
    tracker.reset();
    for (const [output, ms, reasoning] of [[1001, 10_000, 0], [501, 5000, 0], [1000 + tokens, 100, 1000]] as const) {
      tracker.requestStart(); const p = producer(output, reasoning);
      p.text(5000, "first"); p.text(5000 + ms, "last"); p.done(); tracker.finish(p.message as any);
    }
    assert.equal(tracker.snapshot()?.tokensPerSecond, tokens === 64 ? 1563 / 15.1 : 640);
    assert.equal(tracker.snapshot()?.sampleCount, tokens === 64 ? 3 : 1);
  }
});

test("implicit model, provider or effort changes cannot reuse another cohort's history", t => {
  const { tracker, producer } = fixture(t);
  for (const field of ["provider", "api", "model", "reportedModel", "thinkingLevel", "missing model"]) {
    tracker.reset(); tracker.requestStart();
    const previous = producer(1001); previous.text(1000, "first"); previous.text(11_000, "last"); previous.done(); tracker.finish(previous.message as any);
    tracker.requestStart(); const current = producer(5);
    if (field === "missing model") delete (current.message as any).model;
    else (current.message as any)[field] = field === "thinkingLevel" ? "high" : field === "api" ? "openai-completions" : "other";
    current.text(1000, "first"); current.text(1010, "last"); current.done(); tracker.finish(current.message as any);
    assert.equal(tracker.snapshot()?.tokensPerSecond, 400, field);
    assert.equal(tracker.snapshot()?.sampleCount, 1, field);
  }
});

test("unsafe pooled counter sums fall back to the current valid response", t => {
  const { tracker, producer } = fixture(t);
  for (const tokens of [Number.MAX_SAFE_INTEGER, 21]) {
    tracker.requestStart(); const p = producer(tokens);
    p.text(1000, "first"); p.text(1400, "last"); p.done(); tracker.finish(p.message as any);
  }
  assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
  assert.equal(tracker.snapshot()?.sampleCount, 1);
});

test("clearing history preserves the pending request; reset also drops all smoothing history", t => {
  const { tracker, producer } = fixture(t);
  const complete = (tokens: number, ms: number) => {
    const p = producer(tokens); p.text(1000, "first"); p.text(1000 + ms, "last");
    p.done(); tracker.finish(p.message as any);
  };
  tracker.requestStart(); complete(41, 400);
  tracker.requestStart(); complete(21, 400);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 75);
  assert.equal(tracker.snapshot()?.sampleCount, 2);
  tracker.requestStart(); tracker.clearSample();
  assert.equal(tracker.snapshot(), undefined);
  complete(11, 500);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 20);
  assert.equal(tracker.snapshot()?.sampleCount, 1);
  tracker.reset(); tracker.requestStart(); complete(21, 400);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
  assert.equal(tracker.snapshot()?.sampleCount, 1);
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

test("single/buffered chunks, backfills, unstreamed tools and invalid completions preserve the previous valid rate", t => {
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
  assert.equal(formatSpeed(38.54, 2), "gen(avg2) 38.5 tok/s");
  assert.equal(formatSpeed(123.4, 3), "gen(avg3) 123 tok/s");
  assert.equal(formatSpeed(1 / 60), "gen(last) 0.017 tok/s");
  assert.equal(formatSpeedValue(1e-9), "1e-9");
  for (const rate of [undefined, NaN, Infinity, -1, 0]) assert.equal(formatSpeed(rate), "");
});
