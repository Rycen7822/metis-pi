import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG } from "../../src/condense/config.ts";
import { FallbackController } from "../../src/condense/summarizer-fallback.ts";
import { summarizeBatch, summarizeRange } from "../../src/condense/summarizer.ts";
import { summarizerInputBudget } from "../../src/condense/summarizer-models.ts";
import { disableNetwork } from "../helpers/native-provider.mjs";

test.beforeEach(disableNetwork);
const usage = { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const config = { ...DEFAULT_CONFIG, summarizerModel: "default", summarizerFallbackModels: [],
  summarizerIdleTimeoutMs: 1000, summarizerMaxTimeoutMs: 2000 };

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "metis-native-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models.json"), refreshOnCreate: false });
  const calls = [], notices = [];
  const add = (name, respond, { contextWindow = 100000, maxTokens = 1000 } = {}) => {
    const model = { id: name, name, provider: `native-summary-${name}`, api: "private-native-summary-api",
      baseUrl: "http://invalid", reasoning: true, input: ["text"], contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    runtime.registerProvider(model.provider, { api: model.api, apiKey: "offline-fixture", baseUrl: model.baseUrl,
      models: [model], streamSimple(m, context, options) {
        calls.push({ model: m, context, options });
        const out = createAssistantMessageEventStream();
        const complete = (text = "Native summary", stopReason = "stop") => {
          const message = { role: "assistant", api: m.api, provider: m.provider, model: m.id,
            content: [{ type: "text", text }], timestamp: 1, stopReason, usage,
            ...(stopReason === "error" ? { errorMessage: text } : {}) };
          out.push({ type: "done", reason: stopReason, message }); out.end(message);
        };
        queueMicrotask(() => respond ? respond({ complete, options, model: m, context }) : complete());
        return out;
      } });
    return model;
  };
  const ctx = model => ({ model, modelRegistry: new ModelRegistry(runtime),
    sessionManager: { getSessionId: () => "summary-session" },
    ui: { notify: (message, kind) => notices.push({ message, kind }) } });
  return { add, ctx, calls, notices };
}

test("batch and range summaries use the configured private native provider", async t => {
  const f = await fixture(t), model = f.add("primary");
  const reports = [], attempts = [];
  const options = { onUsage: report => reports.push(report), onModelAttempt: () => attempts.push(true) };
  const batch = { timestamp: 1, turnIndex: 0, toolCalls: [{ toolCallId: "read-a", toolName: "read",
    args: { path: "source.txt" }, resultText: "Observed source", isError: false }] };
  const selected = { ...config, summarizerThinking: "high" };
  const batchSummary = await summarizeBatch(batch, selected, f.ctx(model), options);
  const rangeSummary = await summarizeRange("Archived summary", selected, f.ctx(model), options);
  assert.equal(batchSummary?.summaryText, "Native summary");
  assert.equal(rangeSummary?.summaryText, "Native summary");
  assert.equal(f.calls.length, 2, "private provider is invoked without a global compatibility API registration");
  assert.ok(JSON.stringify(f.calls[0].context).includes("Observed source"));
  assert.ok(JSON.stringify(f.calls[1].context).includes("Archived summary"));
  assert.ok(f.calls.every(call => call.options.reasoning === "high" && call.options.maxTokens === 1000));
  assert.ok(f.calls.every(call => call.options.sessionId === "summary-session"), "route summaries in the owning conversation");
  assert.deepEqual(reports, [usage, usage]);
  assert.equal(attempts.length, 2);
  assert.deepEqual(f.notices, []);
});

test("caller admission failures propagate without provider calls or outage fallback", async t => {
  const f = await fixture(t), primary = f.add("primary"), fallback = f.add("fallback");
  const selected = { ...config, summarizerModel: `${primary.provider}/${primary.id}` };
  const controller = new FallbackController(), failure = new Error("local spending journal unavailable");
  await assert.rejects(summarizeRange("Evidence", selected, f.ctx(fallback), {
    controller, acceptRequest: async () => { throw failure; },
  }), error => error === failure);
  assert.equal(f.calls.length, 0);
  assert.equal((await summarizeRange("Evidence", selected, f.ctx(fallback), { controller })).summaryText, "Native summary");
  assert.equal(f.calls[0].model.id, "primary", "local failure must not poison the provider-health route");
});

test("summary budgets consume refreshed native model limits", async t => {
  const f = await fixture(t), model = f.add("primary"), ctx = f.ctx(model);
  const selected = { ...config, summarizerModel: `${model.provider}/${model.id}` };
  const originalBudget = summarizerInputBudget(selected, ctx);
  f.add("primary", undefined, { contextWindow: 8000, maxTokens: 600 });
  const smallerBudget = summarizerInputBudget(selected, ctx);
  assert.ok(smallerBudget > 0 && smallerBudget < originalBudget);
  assert.equal((await summarizeRange("Evidence", selected, ctx))?.summaryText, "Native summary");
  assert.equal(f.calls[0].model.contextWindow, 8000);
  assert.ok(f.calls[0].options.maxTokens > 0 && f.calls[0].options.maxTokens <= 600);
});

test("summary requests reserve the enforced output cap with room for configured reasoning", async t => {
  const { streamSimple } = await import("@earendil-works/pi-ai/api/anthropic-messages");
  const caps = [];
  for (const reasoning of ["off", "low", "high"]) await t.test(reasoning, async t => {
    const f = await fixture(t);
    let payload, reserved;
    const model = f.add("legacy-thinking", ({ complete, options, model, context }) => {
      const capture = streamSimple({ ...model, api: "anthropic-messages" }, context, {
        ...options, apiKey: "offline-summary-capture",
        onPayload: body => { payload = body; throw new Error("OFFLINE_CAPTURE_COMPLETE"); },
      });
      void capture.result().then(message => complete(payload ? "Native summary" : message.errorMessage,
        payload ? "stop" : "error"));
    }, { contextWindow: 1048576, maxTokens: 393216 });
    const result = await summarizeRange("Evidence", { ...config, summarizerThinking: reasoning }, f.ctx(model), {
      outputBudget: { minimumGain: 2048, limit: 1024, target: 512 },
      acceptRequest: async (_model, _message, maxTokens) => { reserved = maxTokens; return true; },
    });
    assert.equal(result?.summaryText, "Native summary");
    assert.ok(reserved >= 2048 && reserved < 32768, "a short summary must not reserve the model's whole output capacity");
    assert.equal(f.calls[0].options.maxTokens, reserved, "admission and dispatch share one output ceiling");
    assert.equal(f.calls[0].options.reasoning, reasoning === "off" ? undefined : reasoning);
    assert.equal(model.maxTokens, 393216, "summary limits must not change the registered model");
    assert.ok(payload.max_tokens <= reserved, "the SDK's additive thinking budget must stay inside the reservation");
    if (reasoning !== "off") assert.ok(payload.thinking.budget_tokens > 0 && payload.thinking.budget_tokens < payload.max_tokens);
    caps.push(reserved);
  });
  assert.ok(caps[0] < caps[1] && caps[1] < caps[2], "reasoning has a separate allowance from visible summary text");
});

test("native provider failure advances the fallback and retains its session route", async t => {
  const f = await fixture(t);
  const primary = f.add("primary", ({ complete }) => complete("offline primary unavailable", "error"));
  const fallback = f.add("fallback");
  const selected = { ...config, summarizerThinking: "off", summarizerFallbackModels: [`${fallback.provider}/${fallback.id}`] };
  const options = { controller: new FallbackController() };
  assert.equal((await summarizeRange("Evidence", selected, f.ctx(primary), options))?.summaryText, "Native summary");
  assert.equal((await summarizeRange("Later evidence", selected, f.ctx(primary), options))?.summaryText, "Native summary");
  assert.deepEqual(f.calls.map(call => call.model.id), ["primary", "fallback", "fallback"]);
  assert.ok(f.calls.every(call => call.options.reasoning === undefined));
  assert.equal(f.notices.filter(notice => notice.kind === "warning").length, 1);
});

test("user cancellation reaches the native request and propagates without fallback", { timeout: 5000 }, async t => {
  const f = await fixture(t), controller = new AbortController();
  const entered = Promise.withResolvers();
  const primary = f.add("cancel", ({ complete, options }) => {
    options.signal.addEventListener("abort", () => complete("cancelled", "aborted"), { once: true });
    entered.resolve();
  });
  const pending = summarizeRange("Evidence", config, f.ctx(primary), { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.deepEqual(f.notices, []);
});

test("idle timeout cancels the native request and retains the original evidence", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const primary = f.add("idle", ({ complete, options }) => {
    options.signal.addEventListener("abort", () => complete("timed out", "aborted"), { once: true });
  });
  const failures = [];
  const summary = await summarizeRange("Evidence", { ...config, summarizerIdleTimeoutMs: 20 }, f.ctx(primary),
    { onFailure: message => failures.push(message) });
  assert.equal(summary, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.ok(failures.some(message => message.includes("stalled")));
});
