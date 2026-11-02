import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { OutputSpeedTracker, computeSpeed, formatSpeed, formatSpeedValue } from "../../src/appearance/activity/output-speed.ts";

function fixture(t: TestContext) {
  let now = 0;
  const epoch = Date.UTC(2026, 0, 1);
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => epoch + now);
  const tracker = new OutputSpeedTracker();
  const response = (output: unknown = 100, durationMs: unknown = 2000, reasoning: unknown = 0) => ({
    role: "assistant", provider: "p", api: "openai-responses", model: "m" as string | undefined,
    reportedModel: undefined as unknown, thinkingLevel: undefined as unknown, responseId: "same-id",
    timestamp: Date.now(), stopReason: "stop", usage: { output, reasoning }, durationMs,
    content: [] as Array<Record<string, unknown>>,
  });
  const producer = (output = 100, reasoning: unknown = 0) => {
    const started = now;
    const stream = createAssistantMessageEventStream();
    const message = response(output, undefined, reasoning);
    message.durationMs = undefined; // Let the real SDK stamp its completion, not the fixture.
    message.content.push({ type: "text", text: "" });
    const partial = message as unknown as AssistantMessage;
    stream.push({ type: "start", partial });
    return { message, stream,
      text(ms: number, delta: string) {
        now = started + ms;
        message.content[0]!.text = String(message.content[0]!.text) + delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
      },
      done(ms: number, endOnly = false) {
        now = started + ms;
        if (endOnly) stream.end(partial);
        else { stream.push({ type: "done", reason: "stop", message: partial }); stream.end(); }
      },
    };
  };
  const complete = (output: number, duration: number, reasoning = 0) => {
    tracker.requestStart(); tracker.finish(response(output, duration, reasoning));
    return tracker.snapshot()!;
  };
  return { tracker, response, producer, complete, tick: (ms: number) => { now += ms; } };
}

test("full native response throughput is invariant to first-batch size, including one buffered chunk", t => {
  const { tracker, producer } = fixture(t);
  // The generator emits 100 tokens at 50 tok/s. Only transport batching changes.
  for (const firstTokens of [1, 60, 90, 91, 100]) {
    tracker.reset(); tracker.requestStart(); const p = producer();
    p.text(firstTokens * 20, "x".repeat(firstTokens));
    if (firstTokens < 100) p.text(2000, "x".repeat(100 - firstTokens));
    p.done(2000);
    tracker.finish(p.message);
    assert.deepEqual(tracker.snapshot(), { outputTokens: 100, durationMs: 2000,
      tokensPerSecond: 50, sampleCount: 1 }, `first batch contains ${firstTokens} tokens`);
  }
});

test("initial wait and thinking are included, while queued completion callbacks cannot extend native duration", t => {
  const { tracker, producer, tick } = fixture(t);
  for (const [wait, tokens, reasoning] of [[0, 100, 0], [10_000, 1100, 1000]]) {
    tracker.reset(); tracker.requestStart(); const p = producer(tokens, reasoning);
    p.text(wait + 20, "first"); p.text(wait + 2000, "last"); p.done(wait + 2000);
    tick(20_000); tracker.finish(p.message);
    assert.equal(tracker.snapshot()?.tokensPerSecond, tokens / ((wait + 2000) / 1000));
    assert.equal(tracker.snapshot()?.durationMs, wait + 2000);
  }
});

test("unstreamed tool arguments and terminal backfills use the whole response, not an argument tail", t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const p = producer(100);
  p.message.content = [{ type: "toolCall", id: "t", name: "read", arguments: { path: "large file" } }];
  p.done(2000, true); p.message.stopReason = "toolUse";
  tracker.finish(p.message);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
});

test("short outputs pool complete raw counts and durations, never averages of averages", t => {
  const { tracker, complete, response } = fixture(t);
  complete(1000, 10_000); complete(500, 5000);
  const previous = tracker.snapshot();
  tracker.requestStart(); tracker.finish({ ...response(), stopReason: "error" });
  assert.equal(tracker.snapshot(), previous);
  const short = complete(5, 1000, 3);
  assert.deepEqual(short, { outputTokens: 1505, durationMs: 16_000,
    tokensPerSecond: 1505 / 16, sampleCount: 3 });
  const next = complete(5, 400);
  assert.equal(next.tokensPerSecond, 510 / 6.4, "evict the oldest raw response, not feed back a pooled rate");
  assert.equal(next.sampleCount, 3);
});

test("only short current outputs pool history; routed model, API, provider and effort changes isolate cohorts", t => {
  const { tracker, complete, response } = fixture(t);
  for (const tokens of [64, 65]) {
    tracker.reset(); complete(1000, 10_000); complete(500, 5000);
    const sample = complete(tokens, 100, 32);
    assert.equal(sample.tokensPerSecond, tokens === 64 ? 1564 / 15.1 : 650);
    assert.equal(sample.sampleCount, tokens === 64 ? 3 : 1);
  }
  tracker.reset(); complete(1000, 10_000);
  const thinking = complete(1005, 1000, 1000);
  assert.equal(thinking.tokensPerSecond, 1005, "total output already includes reasoning; do not add or subtract it");
  assert.equal(thinking.sampleCount, 1, "a long reasoning response is not a short response merely because its body is short");
  for (const field of ["provider", "api", "model", "reportedModel", "thinkingLevel", "missing model"] as const) {
    tracker.reset(); complete(1000, 10_000); tracker.requestStart();
    const current = response(5, 100);
    if (field === "missing model") current.model = undefined;
    else current[field] = "other";
    tracker.finish(current);
    assert.equal(tracker.snapshot()?.tokensPerSecond, 50, field);
    assert.equal(tracker.snapshot()?.sampleCount, 1, field);
  }
});

test("unsafe pooled counts and durations fall back to the valid current response", t => {
  const { tracker, complete } = fixture(t);
  for (const duration of [1000, Number.MAX_VALUE]) {
    tracker.reset(); complete(Number.MAX_SAFE_INTEGER, duration);
    const current = complete(21, 400);
    assert.equal(current.tokensPerSecond, 52.5);
    assert.equal(current.sampleCount, 1);
  }
  tracker.reset(); complete(1, Number.MAX_VALUE);
  const long = complete(1, Number.MAX_VALUE);
  assert.equal(long.tokensPerSecond, computeSpeed(1, Number.MAX_VALUE));
  assert.equal(long.sampleCount, 1, "an infinite summed duration is not a measurable pooled response");
});

test("invalid durations, usage and incomplete responses preserve the previous valid sample", t => {
  const { tracker, response, complete } = fixture(t);
  complete(100, 2000); const previous = tracker.snapshot();
  const invalid = [
    ...[undefined, null, "2000", 0, -1, NaN, Infinity].map(durationMs => ({ ...response(), durationMs })),
    ...[undefined, null, "100", 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map(output => ({ ...response(), usage: { output } })),
    ...["error", "aborted", "deferred", "pending"].map(stopReason => ({ ...response(), stopReason })),
  ];
  for (const message of invalid) {
    tracker.requestStart(); tracker.finish(message);
    assert.equal(tracker.snapshot(), previous);
  }
});

test("only total usage and duration determine throughput, not opaque reasoning or its breakdown", t => {
  const { tracker, response } = fixture(t);
  for (const reasoning of [1000, 0, undefined, null, "0", -1, 1101, 1.5, NaN]) {
    for (const signature of ["opaque", "opaque".repeat(128)]) {
      tracker.reset(); tracker.requestStart();
      const message = response(1100, 12_000, reasoning); message.usage.reasoning = reasoning;
      message.content.push({ type: "thinking", thinking: "summary", thinkingSignature: signature });
      tracker.finish(message);
      assert.equal(tracker.snapshot()?.tokensPerSecond, 1100 / 12);
      assert.equal(tracker.snapshot()?.outputTokens, 1100, "do not infer total output from ciphertext or reasoning detail");
    }
  }
  for (const level of [undefined, "high", "off"]) {
    tracker.reset(); tracker.requestStart(); const message = response();
    message.usage.reasoning = undefined; message.thinkingLevel = level; tracker.finish(message);
    assert.equal(tracker.snapshot()?.tokensPerSecond, 50, "total output does not require inferring whether reasoning was off");
  }
});

test("pooling uses only reported totals and durations when reasoning detail is missing", t => {
  const { tracker, response } = fixture(t);
  tracker.requestStart(); const first = response(1000, 10_000); first.usage.reasoning = undefined;
  tracker.finish(first);
  tracker.requestStart(); tracker.finish(response(10, 1000, 3));
  assert.equal(tracker.snapshot()?.tokensPerSecond, 1010 / 11);
  assert.equal(tracker.snapshot()?.sampleCount, 2);
  assert.deepEqual(tracker.snapshot(), { outputTokens: 1010, durationMs: 11_000, tokensPerSecond: 1010 / 11, sampleCount: 2 });
});

test("tool results and older warmers with identical IDs cannot consume the pending main response", t => {
  const { tracker, producer, response, tick } = fixture(t);
  const warmer = producer(); tick(1000);
  tracker.requestStart(); const main = producer();
  tracker.finish({ ...response(50_000, 1), role: "toolResult" });
  warmer.done(1500); tracker.finish(warmer.message);
  main.done(2000); tracker.finish(main.message);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
});

test("duplicate, reset and stale completions do not resurrect samples; compaction only clears history", t => {
  const { tracker, complete, response, tick } = fixture(t);
  const previous = complete(100, 2000);
  tracker.requestStart(); const stale = response(100, 2000);
  tracker.reset(); tracker.finish(stale); assert.equal(tracker.snapshot(), undefined);
  tick(5000); tracker.requestStart(); tracker.clearSample(); tracker.finish(stale);
  assert.equal(tracker.snapshot(), undefined);
  tracker.finish(response(50, 1000)); assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
  const completed = response(25, 1000);
  tracker.requestStart(); tracker.finish(completed);
  const sample = tracker.snapshot(); tracker.requestStart(); tracker.finish(completed);
  assert.equal(tracker.snapshot(), sample, "the same completed object cannot be counted in a later request");
  tracker.finish(response(100, 1000)); assert.equal(tracker.snapshot()?.tokensPerSecond, 100);
  assert.notEqual(tracker.snapshot(), previous);
});

test("native forwarding preserves producer duration rather than timing a later delivery stream", t => {
  const { tracker, producer, tick } = fixture(t);
  tracker.requestStart(); const source = producer(); source.text(2000, "buffered"); source.done(2000);
  const forwarded = createAssistantMessageEventStream();
  tick(5000); forwarded.end(source.message as unknown as AssistantMessage);
  tracker.finish(source.message);
  assert.equal(source.message.durationMs, 2000);
  assert.equal(tracker.snapshot()?.tokensPerSecond, 50);
});

for (const [tokens, ms, expected] of [
  [0, 10000, undefined], [1, 1000, 1], [-1, 1000, undefined], [1.5, 1000, undefined],
  [NaN, 1000, undefined], [Number.MAX_SAFE_INTEGER + 1, 1000, undefined], [10, NaN, undefined],
  [10, Infinity, undefined], [10, -1, undefined], [10, 0, undefined], [10, Number.MIN_VALUE, undefined],
  [2, 60000, 1 / 30], [3, 4000, 0.75], [4, 300, 4 / 0.3], [5002, 1000, 5002],
] as const) {
  test(`full-response throughput: ${tokens} tokens in ${ms}ms`, () => assert.equal(computeSpeed(tokens, ms), expected));
}

test("formatting names output throughput and never rounds a slow measured rate to zero", () => {
  assert.equal(formatSpeed(38.54), "out(last) 38.5 tok/s");
  assert.equal(formatSpeed(123.4), "out(last) 123 tok/s");
  assert.equal(formatSpeed(38.54, 2), "out(avg2) 38.5 tok/s");
  assert.equal(formatSpeed(123.4, 3), "out(avg3) 123 tok/s");
  assert.equal(formatSpeed(1 / 60), "out(last) 0.017 tok/s");
  assert.equal(formatSpeedValue(1e-9), "1e-9");
  for (const rate of [undefined, NaN, Infinity, -1, 0]) assert.equal(formatSpeed(rate), "");
});
