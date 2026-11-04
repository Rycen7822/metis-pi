import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextDelivery } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { OutputSpeedTracker, computeSpeed, formatSpeed, formatSpeedValue } from "../../src/appearance/activity/output-speed.ts";

function generationSample(tracker: OutputSpeedTracker) {
  const sample = tracker.snapshot();
  if (!sample) return;
  assert.equal(sample.kind, "calibrated", "a completed usage-calibrated rate must not be replaced with a character estimate");
  return sample;
}

function fixture(t: TestContext) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1) + now);
  const tracker = new OutputSpeedTracker();
  t.after(() => tracker.reset());
  const producer = (output = 100, reasoning = 0) => {
    const started = now;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const, provider: "p", api: "openai-responses" as const, model: "m",
      timestamp: Date.now(), stopReason: "stop" as AssistantMessage["stopReason"],
      usage: { input: 0, output, reasoning, cacheRead: 0, cacheWrite: 0, totalTokens: output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [] as AssistantMessage["content"], durationMs: undefined as number | undefined,
    };
    stream.push({ type: "start", partial: message });
    return { message, stream,
      text(ms: number, delta: string, index = 0) {
        now = started + ms;
        let block = message.content[index];
        if (!block) {
          block = { type: "text", text: "" };
          message.content[index] = block;
          stream.push({ type: "text_start", contentIndex: index, partial: message });
        }
        assert.equal(block.type, "text");
        if (block.type === "text") block.text += delta;
        stream.push({ type: "text_delta", contentIndex: index, delta, partial: message });
      },
      done(ms: number, endOnly = false) {
        now = started + ms;
        if (endOnly) stream.end(message);
        else if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message }); stream.end();
        } else {
          assert.ok(message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse");
          stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
        }
      },
    };
  };
  // A controlled generator emits one character per token at a constant rate; delivery can batch them.
  const complete = async (tokens = 100, ms = 2000, wait = 0, reasoning = 0) => {
    tracker.requestStart(); const p = producer(tokens + reasoning, reasoning);
    p.text(wait + ms / tokens, "x"); await nextDelivery();
    p.text(wait + ms, "x".repeat(tokens - 1)); p.done(wait + ms);
    tracker.finish(p.message);
    return generationSample(tracker)!;
  };
  return { tracker, producer, complete, tick: (ms: number) => { now += ms; } };
}

test("live text rate updates before completion and excludes thinking gaps", async t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const p = producer(1200, 1000);
  p.message.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque" });
  p.text(40_020, "x", 1); tracker.outputDelta(p.message);
  assert.equal(tracker.snapshot(), undefined, "one batch has no observed generation interval");
  await nextDelivery(); p.text(42_000, "x".repeat(99), 1); tracker.outputDelta(p.message);
  assert.deepEqual(tracker.snapshot(), {
    estimatedTokens: 24.75, durationMs: 1980, tokensPerSecond: 12.5, sampleCount: 1, kind: "live",
  });
  p.message.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque" });
  p.stream.push({ type: "thinking_start", contentIndex: 2, partial: p.message });
  assert.equal(tracker.snapshot(), undefined, "a body rate is not presented as live during thinking");
  p.text(90_020, "x", 3); tracker.outputDelta(p.message);
  await nextDelivery(); p.text(91_010, "x".repeat(99), 3); tracker.outputDelta(p.message);
  assert.deepEqual(tracker.snapshot(), {
    estimatedTokens: 49.5, durationMs: 2970, tokensPerSecond: 49.5 / 2.97, sampleCount: 1, kind: "live",
  });
  p.done(92_000); tracker.finish(p.message);
  assert.equal(generationSample(tracker)?.tokensPerSecond, 198 / 2.97, "final usage calibrates both measured body windows");
});

test("live rate never times forwarded consumer callbacks or keeps data after disposal", async t => {
  const { tracker, producer, tick } = fixture(t);
  tracker.requestStart(); const p = producer();
  const forwarded = createAssistantMessageEventStream();
  p.text(20, "x"); forwarded.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: p.message });
  await nextDelivery(); p.text(2000, "x".repeat(99)); tick(20_000);
  forwarded.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(99), partial: p.message });
  tracker.outputDelta(p.message);
  assert.deepEqual(tracker.snapshot(), {
    estimatedTokens: 24.75, durationMs: 1980, tokensPerSecond: 12.5, sampleCount: 1, kind: "live",
  }, "the first producer owns timing");
  p.done(22_000); forwarded.end(p.message);
  assert.equal(tracker.snapshot(), undefined, "queued events cannot present a finished producer as still live");
  tracker.reset();
  assert.equal(tracker.snapshot(), undefined);
});

test("tool-call batches show characters/4 live, calibrate on completion and exclude execution time", async t => {
  const { tracker, producer, tick } = fixture(t);
  for (const count of [1, 2]) {
    tracker.reset(); tracker.requestStart(); const p = producer(1000 + 100 * count, 1000);
    for (let contentIndex = 0; contentIndex < count; contentIndex++) {
      if (contentIndex > 0) tick(40_000); // An unobserved gap between calls is not argument generation time.
      const toolCall = { type: "toolCall" as const, id: `t${contentIndex}`, name: "read", arguments: {} };
      p.message.content.push(toolCall);
      p.stream.push({ type: "toolcall_start", contentIndex, partial: p.message });
      tick(20);
      p.stream.push({ type: "toolcall_delta", contentIndex, delta: '{"text":"', partial: p.message });
      await nextDelivery(); tick(1820);
      p.stream.push({ type: "toolcall_delta", contentIndex, delta: `${"x".repeat(89)}"}`, partial: p.message });
      tracker.outputDelta(p.message);
      assert.equal(tracker.snapshot()?.tokensPerSecond, 12.5, "91 characters / 4 / 1.82 seconds per call");
      assert.equal(tracker.snapshot()?.kind, "live");
      toolCall.arguments = { text: "x".repeat(89) };
      p.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: p.message });
    }
    p.message.stopReason = "toolUse"; p.done(1840 * count + 40_000 * (count - 1)); tracker.finish(p.message);
    const batch = generationSample(tracker);
    assert.equal(batch?.tokensPerSecond, 50, "known non-reasoning tokens calibrate the observed 91% share of the whole batch");
    assert.equal(batch?.sampleCount, 1, "multiple calls are one completed model batch");
    tick(60_000);
    tracker.finish({ role: "toolResult", durationMs: 60_000, usage: { output: 999_999 } });
    assert.equal(tracker.snapshot(), batch, "tool execution results cannot retime or replace the model batch");
  }
});

test("50 tok/s body is independent of initial wait, opaque thinking and completion/UI delays", async t => {
  const { tracker, producer, tick } = fixture(t);
  for (const wait of [0, 40_000, 100_000]) {
    tracker.reset(); tracker.requestStart(); const p = producer(1100, 1000);
    p.message.content.push({ type: "thinking", thinking: "summary", thinkingSignature: "opaque".repeat(128) });
    p.text(wait + 20, "x", 1); await nextDelivery();
    p.text(wait + 2000, "x".repeat(99), 1); p.done(wait + 5000);
    tick(20_000); tracker.finish(p.message);
    assert.equal(generationSample(tracker)?.tokensPerSecond, 50);
    assert.equal(generationSample(tracker)?.estimatedTokens, 99);
    assert.equal(generationSample(tracker)?.durationMs, 1980);
    assert.equal(tracker.throughput()?.tokensPerSecond, 1100 / ((wait + 5000) / 1000));
  }
});

test("first-batch tokens are excluded with their unobserved time, not divided by a tiny tail", async t => {
  const { tracker, producer } = fixture(t);
  for (const first of [1, 20, 50, 60, 90, 100]) {
    tracker.reset(); tracker.requestStart(); const p = producer();
    p.text(first * 20, "x".repeat(first)); await nextDelivery();
    if (first < 100) p.text(2000, "x".repeat(100 - first));
    p.done(2000); tracker.finish(p.message);
    if (first <= 50) assert.equal(generationSample(tracker)?.tokensPerSecond, 50);
    else assert.equal(tracker.snapshot(), undefined, "one delivery or a majority-buffered body is not enough observation");
    assert.equal(tracker.throughput()?.tokensPerSecond, 50, "whole-response diagnostic remains available");
  }
});

test("synchronous and microtask deltas from one wire delivery do not become independent timed batches", async t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const p = producer();
  p.text(600, "x".repeat(30)); await Promise.resolve(); p.text(1000, "x".repeat(20));
  await nextDelivery(); p.text(1600, "x".repeat(50)); p.done(1600);
  tracker.finish(p.message);
  assert.equal(generationSample(tracker)?.tokensPerSecond, 50, "one first delivery starts at 600, not at its last normalized delta");
  tracker.reset(); tracker.requestStart(); const buffered = producer();
  for (let i = 0; i < 100; i++) buffered.text(i * 20, "x");
  buffered.done(2000); tracker.finish(buffered.message);
  assert.equal(tracker.snapshot(), undefined);
});

test("interleaved thinking splits text windows without counting reasoning tokens or time", async t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const p = producer(1200, 1000);
  p.text(20, "x"); await nextDelivery(); p.text(2000, "x".repeat(99));
  p.message.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque" });
  p.stream.push({ type: "thinking_start", contentIndex: 1, partial: p.message });
  p.text(100_020, "x", 2); await nextDelivery(); p.text(102_000, "x".repeat(99), 2);
  p.done(102_000); tracker.finish(p.message);
  assert.equal(generationSample(tracker)?.tokensPerSecond, 50);
  assert.equal(generationSample(tracker)?.durationMs, 3960);
});

test("separate text blocks do not time hidden work between one body ending and the next beginning", async t => {
  const { tracker, producer } = fixture(t);
  tracker.requestStart(); const p = producer(200);
  p.text(20, "x"); await nextDelivery(); p.text(2000, "x".repeat(99));
  p.stream.push({ type: "text_end", contentIndex: 0, content: "x".repeat(100), partial: p.message });
  p.text(42_020, "x", 1); await nextDelivery(); p.text(44_000, "x".repeat(99), 1);
  p.done(44_000); tracker.finish(p.message);
  assert.equal(generationSample(tracker)?.tokensPerSecond, 50);
  assert.equal(generationSample(tracker)?.durationMs, 3960);
});

test("terminal backfills, unstreamed tool arguments and sub-100ms windows do not claim a generation rate", async t => {
  const { tracker, producer } = fixture(t);
  for (const kind of ["backfill", "mixed", "tiny", "tool-only"]) {
    tracker.reset(); tracker.requestStart(); const p = producer();
    if (kind !== "tool-only") {
      p.text(20, "x"); await nextDelivery(); p.text(kind === "tiny" ? 40 : 2000, "x".repeat(99));
    }
    if (kind === "backfill") p.message.content.push({ type: "text", text: "not streamed" });
    if (kind === "mixed" || kind === "tool-only")
      p.message.content.push({ type: "toolCall", id: "t", name: "read", arguments: { path: "file" } });
    p.done(2000, true); tracker.finish(p.message);
    assert.equal(tracker.snapshot(), undefined, kind);
    assert.equal(tracker.throughput()?.tokensPerSecond, 50);
  }
});

test("missing, inconsistent or invalid reasoning details cannot leak hidden tokens into the body rate", async t => {
  const { tracker, producer } = fixture(t);
  for (const reasoning of [undefined, null, "0", -1, 1101, 1.5, NaN, 0]) {
    tracker.reset(); tracker.requestStart(); const p = producer(1100);
    Object.assign(p.message.usage, { reasoning });
    p.message.content.push({ type: "thinking", thinking: "", thinkingSignature: "opaque" });
    p.text(20, "x", 1); await nextDelivery(); p.text(2000, "x".repeat(99), 1); p.done(2000);
    tracker.finish(p.message);
    assert.deepEqual(tracker.snapshot(), {
      estimatedTokens: 24.75, durationMs: 1980, tokensPerSecond: 12.5, sampleCount: 1, kind: "estimated",
    }, "unreported reasoning keeps a labeled characters/4 estimate, never hidden tokens");
    assert.equal(tracker.throughput()?.tokensPerSecond, 550, "total throughput does not depend on a reasoning breakdown");
  }
});

test("short bodies pool measured token/time pairs, with bounded history and model/effort isolation", async t => {
  const { tracker, producer, complete } = fixture(t);
  await complete(100, 2000); await complete(50, 500); const pooled = await complete(20, 400);
  assert.equal(pooled.tokensPerSecond, 167 / 2.85);
  assert.equal(pooled.sampleCount, 3);
  assert.equal((await complete(40, 400)).tokensPerSecond, 107 / 1.26, "evict the oldest raw sample, not average averages");
  const long = await complete(100, 1000);
  assert.equal(long.tokensPerSecond, 100, "a long current body is never diluted by earlier short bodies");
  assert.equal(long.sampleCount, 1);
  for (const field of ["provider", "api", "model", "responseModel", "thinkingLevel", "providerThinkingLevel"]) {
    tracker.reset(); await complete(100, 2000); tracker.requestStart(); const p = producer(20);
    Object.assign(p.message, { [field]: "other" });
    p.text(20, "x"); await nextDelivery(); p.text(400, "x".repeat(19)); p.done(400); tracker.finish(p.message);
    assert.equal(generationSample(tracker)?.tokensPerSecond, 50, field);
    assert.equal(generationSample(tracker)?.sampleCount, 1, field);
  }
});

test("a current body hides a prior rate; failures without text preserve it and resets reject late completions", async t => {
  const { tracker, producer, complete } = fixture(t);
  const previous = await complete();
  tracker.requestStart(); const failed = producer(); failed.message.stopReason = "error";
  failed.done(1000); tracker.finish(failed.message); assert.equal(tracker.snapshot(), previous);
  tracker.requestStart(); tracker.outputDelta(); assert.equal(tracker.snapshot(), undefined);
  const late = producer(); late.text(20, "x"); await nextDelivery(); late.text(2000, "x".repeat(99));
  tracker.reset(); late.done(2000); tracker.finish(late.message);
  assert.equal(tracker.snapshot(), undefined); assert.equal(tracker.throughput(), undefined);
});

test("invalid native counts, durations and incomplete responses cannot replace valid diagnostic throughput", async t => {
  const { tracker, producer, complete } = fixture(t);
  await complete(); const previous = tracker.throughput();
  const invalid = [
    ...[undefined, null, "2000", 0, -1, NaN, Infinity].map(durationMs => ({ durationMs })),
    ...[undefined, null, "100", 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1].map(output => ({ usage: { output } })),
    ...["error", "aborted", "pending", "deferred"].map(stopReason => ({ stopReason })),
  ];
  for (const changes of invalid) {
    tracker.requestStart(); const p = producer();
    Object.assign(p.message, { durationMs: 2000 }, changes);
    tracker.finish(p.message);
    assert.equal(tracker.throughput(), previous);
  }
});

test("duplicates, tool results and stale warmers cannot consume or overwrite the main response", async t => {
  const { tracker, producer, tick } = fixture(t);
  const warmer = producer(); tick(1000); tracker.requestStart(); const main = producer();
  tracker.finish({ role: "toolResult", usage: { output: 50_000 }, durationMs: 1 });
  warmer.text(1020, "x"); main.text(20, "x"); await nextDelivery();
  warmer.text(3000, "x".repeat(99)); warmer.done(3000); tracker.finish(warmer.message);
  main.text(2000, "x".repeat(99)); main.done(2000);
  tracker.finish(main.message); const sample = generationSample(tracker); assert.equal(sample?.tokensPerSecond, 50);
  tracker.requestStart(); tracker.finish(main.message); assert.equal(tracker.snapshot(), sample);
  const next = producer(); next.text(10, "x"); await nextDelivery(); next.text(1000, "x".repeat(99)); next.done(1000);
  tracker.finish(next.message); assert.equal(generationSample(tracker)?.tokensPerSecond, 100);
});

test("forwarded streams preserve source timing with independent observer leases", async t => {
  const { tracker, producer, tick } = fixture(t);
  const another = new OutputSpeedTracker(); another.requestStart();
  tracker.requestStart(); const p = producer(); p.text(20, "x"); await nextDelivery(); p.text(2000, "x".repeat(99)); p.done(2000);
  tick(5000); const forwarded = createAssistantMessageEventStream(); forwarded.end(p.message);
  tracker.finish(p.message); assert.equal(generationSample(tracker)?.tokensPerSecond, 50);
  another.reset(); another.reset();
  assert.equal(p.message.durationMs, 2000);
});

test("observer leases restore SDK methods and never replace a third-party wrapper on disposal", () => {
  const prototype = Object.getPrototypeOf(createAssistantMessageEventStream());
  const original: AssistantMessageEventStream["push"] = prototype.push;
  const originalEnd = prototype.end;
  const first = new OutputSpeedTracker(), second = new OutputSpeedTracker();
  first.requestStart(); second.requestStart();
  const observed = prototype.push;
  first.reset(); assert.equal(prototype.push, observed);
  const foreign = function (this: AssistantMessageEventStream, event: Parameters<typeof original>[0]) { return observed.call(this, event); };
  prototype.push = foreign;
  second.reset(); assert.equal(prototype.push, foreign); assert.equal(prototype.end, originalEnd);
  const stream = createAssistantMessageEventStream(); stream.end();
  prototype.push = original;
});

for (const [tokens, ms, expected] of [
  [0, 1000, undefined], [1, 1000, 1], [-1, 1000, undefined], [0.5, 1000, 0.5],
  [NaN, 1000, undefined], [Number.MAX_SAFE_INTEGER + 1, 1000, undefined], [10, NaN, undefined],
  [10, Infinity, undefined], [10, -1, undefined], [10, 0, undefined], [10, Number.MIN_VALUE, undefined],
  [2, 60000, 1 / 30], [3, 4000, 0.75], [4, 300, 4 / 0.3], [5002, 1000, 5002],
] as const) {
  test(`estimated speed: ${tokens} tokens in ${ms}ms`, () => assert.equal(computeSpeed(tokens, ms), expected));
}

test("formatting explicitly marks generation estimates and bounded smoothing, including very slow rates", () => {
  const sample = { estimatedTokens: 100, durationMs: 1000, tokensPerSecond: 38.54, sampleCount: 1, kind: "calibrated" as const };
  assert.equal(formatSpeed(sample), "gen≈(last) 38.5 tok/s");
  assert.equal(formatSpeed({ ...sample, tokensPerSecond: 123.4, sampleCount: 3 }), "gen≈(avg3) 123 tok/s");
  assert.equal(formatSpeed({ ...sample, tokensPerSecond: 1 / 60 }), "gen≈(last) 0.017 tok/s");
  assert.equal(formatSpeed({ ...sample, kind: "live", tokensPerSecond: 12.5 }), "gen≈(live) 12.5 tok/s");
  assert.equal(formatSpeed({ ...sample, kind: "estimated", tokensPerSecond: 12.5 }), "gen≈(est) 12.5 tok/s");
  assert.equal(formatSpeedValue(1e-9), "1e-9");
  assert.equal(formatSpeed(undefined), "");
  for (const tokensPerSecond of [NaN, Infinity, -1, 0]) assert.equal(formatSpeed({ ...sample, tokensPerSecond }), "");
});
