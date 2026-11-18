import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  answer, assistant, compactions, completed, createCompactionHost as host, key, model, responsesModel, sse, user,
} from "../helpers/codex-compaction.mjs";
import { modelNamed } from "../helpers/native-provider.mjs";

test("model changes persist portable summaries, clamp output ceilings and preserve encrypted replay", async t => {
  for (const [name, routeModel, oauth] of [["Codex", model, true], ["OAuth Responses", responsesModel, true],
    ["API Responses", responsesModel, false]]) await t.test(name, async t => {
    const credential = oauth ? undefined : { type: "api_key", key: "sk-offline-portable-output" };
    const h = await host(t, { routeModel, oauth, credential });
    const targetModel = { ...routeModel, id: "gpt-6-sol", contextWindow: 32_000, maxTokens: 24_000 };
    await h.session.compact();
    await h.session.setModel(targetModel);
    const calls = h.bodies.length;
    await h.session.prompt("CHANGED MODEL");
    assert.equal(h.bodies.length, calls + 2, "one original-model summary and one target-model inference");
    assert.equal(h.bodies.at(-2).model, routeModel.id);
    assert.equal(h.bodies.at(-2).input.filter(item => item.type === "compaction").length, 1);
    const body = h.bodies.at(-1);
    assert.equal(body.input.some(i => i.type === "compaction"), false);
    assert.match(JSON.stringify(body), /OK/);
    assert.doesNotMatch(JSON.stringify(body), /old work|Metis Codex remote checkpoint/);
    assert.equal(h.sm.getBranch().filter(e => e.type === "custom" && e.customType === "metisCodexPortableSummary").length, 1);
    await h.session.setModel(routeModel);
    await h.session.prompt("ORIGINAL MODEL AGAIN");
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
    await h.session.setModel(targetModel);
    const after = h.bodies.length;
    await h.session.prompt("REUSE PORTABLE SUMMARY");
    assert.equal(h.bodies.length, after + 1);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    // This tail alone is about 14k visible tokens: it fits in 32k, but not beside a full 24k output reservation.
    h.sm.appendMessage(user("PORTABLE TAIL ".repeat(4_000)));
    const beforeTail = h.bodies.length;
    await h.session.prompt("CONTINUE WITHIN THE REMAINING CONTEXT");
    assert.equal(h.bodies.length, beforeTail + 1, "valid input reaches inference without regenerating the saved summary");
    assert.equal(h.session.messages.at(-1).stopReason, "stop");
    assert.match(JSON.stringify(h.bodies.at(-1)), /PORTABLE TAIL/);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    if (!oauth) {
      const limit = h.bodies.at(-1).max_output_tokens;
      assert.ok(limit > 0 && limit < targetModel.maxTokens, "Pi reduces the API output ceiling to the available space");
    }
  });
});

test("portable summaries survive reload and branch navigation without resurrecting source", async t => {
  const h = await host(t);
  await h.session.compact();
  const checkpoint = compactions(h).at(-1);
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("CREATE PORTABLE SUMMARY");
  const path = h.sm.getSessionFile();
  const restored = await host(t, { existing: path, routeModel: modelNamed("gpt-6-sol") });
  await restored.session.prompt("CONTINUE AFTER RELOAD");
  assert.equal(restored.bodies.length, 1, "reloading reuses the persisted portable summary");
  assert.doesNotMatch(JSON.stringify(restored.bodies[0]), /old work|Metis Codex remote checkpoint/);
  await restored.session.navigateTree(checkpoint.id, { summarize: false });
  const calls = restored.bodies.length;
  await restored.session.prompt("FORK BEFORE PORTABLE SUMMARY");
  assert.equal(restored.bodies.length, calls + 2, "another branch materializes its own summary");
  assert.doesNotMatch(JSON.stringify(restored.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
});

test("later context projections cannot replace portable text with the native marker", async t => {
  const h = await host(t, { contextJournal: true });
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("PORTABLE TEXT MUST SURVIVE OTHER PROJECTORS");
  const body = JSON.stringify(h.bodies.at(-1));
  assert.match(body, /PROJECTED DURABLE SUMMARY/);
  assert.match(body, /OK/);
  assert.doesNotMatch(body, /old work|Metis Codex remote checkpoint/);
});

test("later projections cannot silently drop the summary or resurrect raw source", async t => {
  for (const contextJournal of ["raw", "drop-summary"]) await t.test(contextJournal, async t => {
    const h = await host(t, { contextJournal });
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    const calls = h.bodies.length;
    await h.session.prompt("NO RAW OR MISSING HISTORY");
    assert.equal(h.bodies.length, calls + 1, "only encrypted-to-text materialization is allowed");
    assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
    assert.match(h.notices.join("\n"), /summary changed during context projection/);
    await h.session.prompt("RETRY STILL HAS THE UNSAFE PROJECTOR");
    assert.equal(h.bodies.length, calls + 1);
  });
});

test("same-model API and endpoint changes use portable context on the new route", async t => {
  for (const apiChange of [false, true]) await t.test(apiChange ? "API" : "endpoint", async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel({ ...model, baseUrl: "https://changed-route.invalid/v1",
      ...(apiChange ? { api: "openai-responses" } : {}) });
    const calls = h.bodies.length;
    await h.session.prompt("CHANGED ROUTE");
    assert.equal(h.bodies.length, calls + 2);
    assert.match(h.urls.at(-2), /chatgpt\.com/);
    assert.equal(new URL(h.urls.at(-1)).origin, "https://changed-route.invalid");
    assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
  });
});

test("an unavailable original model pauses or reuses existing portable text without expansion", async t => {
  for (const cached of [false, true]) await t.test(cached ? "cached" : "uncached", async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    if (cached) await h.session.prompt("SAVE PORTABLE TEXT");
    const find = h.runtime.getModel.bind(h.runtime);
    t.mock.method(h.runtime, "getModel", (p, id) => p === model.provider && id === model.id ? undefined : find(p, id));
    const calls = h.bodies.length;
    await h.session.prompt("ORIGINAL MODEL REMOVED");
    assert.equal(h.bodies.length, calls + Number(cached));
    if (cached) assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    else assert.match(h.notices.join("\n"), /Original checkpoint model is unavailable/);
  });
});

test("portable summary failures preserve the checkpoint and never send raw inference", async t => {
  for (const failure of ["http", "empty", "truncated", "model-change", "tail-change"]) await t.test(failure, async t => {
    let failing = true;
    const h = await host(t, { normalResponse: async () => {
      if (!failing) return answer();
      if (failure === "http") return Response.json({ error: { message: "PORTABLE FAILURE", type: "invalid_request_error" } }, { status: 400 });
      if (failure === "empty") return sse([completed([])]);
      if (failure === "truncated") return sse([{
        type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      }]);
      if (failure === "model-change") await h.session.setModel(modelNamed("gpt-6-luna"));
      if (failure === "tail-change") h.sm.appendMessage(user("APPENDED WHILE SUMMARIZING"));
      return answer();
    } });
    await h.session.compact();
    const checkpoint = compactions(h).at(-1), calls = h.bodies.length;
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("FAILED PORTABLE MIGRATION");
    assert.ok(h.bodies.length > calls);
    for (const body of h.bodies.slice(calls)) {
      assert.equal(body.model, model.id, "only the original-model summary may retry");
      assert.equal(body.input.filter(item => item.type === "compaction").length, 1);
    }
    assert.equal(h.sm.getBranch().some(e => e.type === "custom" && e.customType === "metisCodexPortableSummary"), false);
    assert.equal(compactions(h).at(-1), checkpoint);
    assert.match(h.notices.join("\n"), /no history was expanded/);
    failing = false;
    await h.session.prompt("RETRY PORTABLE MIGRATION");
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
    assert.equal(h.bodies.at(-1).input.some(item => item.type === "compaction"), false);
  });
});

test("user cancellation aborts portable generation in ordinary requests and manual compaction", async t => {
  for (const manual of [false, true]) await t.test(manual ? "manual" : "inference", { timeout: 5000 }, async t => {
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    const h = await host(t, { other: true, normalResponse: ({ signal }) => {
      started();
      return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    } });
    await h.session.compact();
    const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
    h.sm.appendMessage(user("KEPT CANCELLATION TAIL"));
    const calls = h.bodies.length;
    const task = (manual ? h.session.compact() : h.session.prompt("CANCEL PORTABLE GENERATION"))
      .then(() => undefined, error => error);
    await waiting;
    if (manual) h.session.abortCompaction();
    else await h.session.abort();
    const error = await task;
    if (manual) assert.match(error?.message ?? "", /cancel|abort/i);
    assert.equal(h.bodies.length, calls + 1);
    assert.equal(h.sm.getBranch().some(e => e.type === "custom" && e.customType === "metisCodexPortableSummary"), false);
    assert.equal(compactions(h).length, 1);
  });
});

test("portable summaries tolerate tail edits but never hide edits to covered source", async t => {
  const h = await host(t);
  const source = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "ORIGINAL USER");
  const tail = h.sm.getBranch().find(e => e.type === "message" && e.message.content === "KEPT TAIL");
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("MIGRATE");
  h.sm.appendContextEdit(tail.id, { content: "CORRECTED TAIL" });
  let calls = h.bodies.length;
  await h.session.prompt("AFTER TAIL EDIT");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /CORRECTED TAIL/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work/);
  h.sm.appendContextEdit(source.id, { content: "EDITED COVERED SOURCE" });
  calls = h.bodies.length;
  await h.session.prompt("AFTER COVERED EDIT");
  assert.equal(h.bodies.length, calls);
  assert.match(h.notices.join("\n"), /edited|invalid/);
});

test("a saved portable summary survives loss of original credentials without exposing ciphertext", async t => {
  const h = await host(t, { other: true });
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("MIGRATE WHILE AUTHENTICATED");
  await h.runtime.removeRuntimeApiKey("openai-codex");
  writeFileSync(join(h.dir, "auth.json"), "{}");
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  const calls = h.bodies.length;
  await h.session.prompt("CACHED CROSS PROVIDER");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /OK/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|opaque-1|Metis Codex remote checkpoint/);
});

test("portable context overflow uses native compaction and retries without expanding history", async t => {
  const sourceModel = { ...responsesModel, id: "gpt-6.1-sol" };
  const targetModel = { ...responsesModel, contextWindow: 32_000, maxTokens: 24_000 };
  let overflowReturned = false;
  const h = await host(t, {
    routeModel: sourceModel, credential: { type: "api_key", key: "sk-offline-portable-overflow" },
    normalResponse: ({ body }) => {
      if (body.model === targetModel.id && !overflowReturned) {
        overflowReturned = true;
        return Response.json({ error: { code: "context_length_exceeded", message: "maximum context length exceeded" } },
          { status: 400 });
      }
      return answer();
    },
  });
  await h.session.compact();
  await h.session.setModel(targetModel);
  h.sm.appendMessage(user("PORTABLE TAIL ".repeat(4_000)));
  const before = h.bodies.length;
  await h.session.prompt("RECOVER THE PORTABLE REQUEST");
  assert.equal(overflowReturned, true, "valid portable input reaches the provider rather than being locally aborted");
  assert.equal(compactions(h).length, 2, "a real provider overflow invokes native checkpoint recovery");
  assert.equal(h.session.messages.at(-1).stopReason, "stop");
  assert.equal(h.bodies.at(-1).model, targetModel.id);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.doesNotMatch(JSON.stringify(h.bodies.slice(before)), /old work|Metis Codex remote checkpoint/);
});

test("automatic compaction after a model switch migrates the checkpoint without raw history", async t => {
  const h = await host(t);
  h.sm.appendMessage(user("HUGE HISTORICAL INPUT ".repeat(5000)));
  h.sm.appendMessage(assistant("archived work"));
  h.sm.appendMessage(user("RECENT TAIL"));
  await h.session.compact();
  h.sm.appendMessage({ ...assistant("pressure", model.contextWindow * 2), model: "gpt-6-sol", timestamp: Date.now() + 1 });
  h.sm.appendMessage(user("RECENT AFTER PRESSURE"));
  const next = await host(t, { existing: h.sm.getSessionFile(), routeModel: {
    ...modelNamed("gpt-6-sol"), contextWindow: 12000, maxTokens: 1024,
  } });
  await next.session.prompt("AUTO COMPACT AND CONTINUE");
  assert.equal(compactions(next).length, 2);
  assert.equal(next.bodies.length, 3, "portable summary, target compaction, then target inference");
  assert.equal(next.bodies[0].model, model.id);
  assert.equal(next.bodies[1].input.at(-1).type, "compaction_trigger");
  assert.doesNotMatch(JSON.stringify(next.bodies.slice(1)), /HUGE HISTORICAL INPUT/);
});

test("automatic compaction can use saved portable text after a credential-kind change", async t => {
  const h = await host(t, { routeModel: responsesModel, oauth: true });
  await h.session.compact();
  await h.session.setModel({ ...responsesModel, id: "gpt-6-sol" });
  await h.session.prompt("SAVE PORTABLE TEXT");
  h.sm.appendMessage({ ...assistant("pressure", responsesModel.contextWindow * 2), api: responsesModel.api,
    provider: responsesModel.provider, model: responsesModel.id, timestamp: Date.now() + 1 });
  h.sm.appendMessage(user("KEPT AUTH RECOVERY TAIL"));
  const next = await host(t, { existing: h.sm.getSessionFile(), routeModel: responsesModel, oauth: false,
    credential: { type: "api_key", key: "sk-offline-cached-recovery" } });
  await next.session.prompt("AUTOMATIC RECOMPACTION AFTER RELOGIN");
  assert.equal(compactions(next).length, 2);
  assert.equal(next.bodies.length, 2, "cached text needs only compaction and normal inference");
  assert.equal(next.bodies[0].input.some(item => item.type === "compaction"), false);
  assert.match(JSON.stringify(next.bodies[0]), /OK/);
  assert.doesNotMatch(JSON.stringify(next.bodies[0]), /old work/);
  assert.equal(next.bodies[1].input.filter(item => item.type === "compaction").length, 1);
});

test("invalid portable cache entries are regenerated without restoring source", async t => {
  for (const damage of ["empty", "oversized", "fingerprint", "marker", "non-text"]) await t.test(damage, async t => {
    const h = await host(t);
    await h.session.compact();
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("CREATE CACHED TEXT");
    const cached = h.sm.getBranch().find(e => e.type === "custom" && e.customType === "metisCodexPortableSummary");
    if (damage === "empty") cached.data.summary = "";
    if (damage === "oversized") cached.data.summary = "x".repeat(65537);
    if (damage === "fingerprint") cached.data.fingerprint = "invalid";
    if (damage === "marker") cached.data.summary = compactions(h).at(-1).summary;
    if (damage === "non-text") cached.data.summary = {};
    const calls = h.bodies.length;
    await h.session.prompt("REGENERATE CACHED TEXT");
    assert.equal(h.bodies.length, calls + 2);
    assert.equal(h.bodies.at(-2).input.filter(item => item.type === "compaction").length, 1);
    assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
  });
});

test("damaged checkpoint metadata cannot expand ordinary requests", async t => {
  for (const damage of ["missing", "invalid", "invalid-model", "marker", "covered-edit"]) await t.test(damage, async t => {
    const h = await host(t);
    await h.session.compact();
    const checkpoint = compactions(h).at(-1), calls = h.bodies.length;
    if (damage === "missing") delete checkpoint.details[key];
    if (damage === "invalid") checkpoint.details[key].history = [{ type: "compaction", encrypted_content: "" }];
    if (damage === "invalid-model") checkpoint.details[key].model = 42;
    if (damage === "marker") checkpoint.summary = "DAMAGED CHECKPOINT MARKER";
    if (damage === "covered-edit") h.sm.appendContextEdit(h.sm.getBranch().find(e => e.type === "message").id, { content: "CHANGED COVERED SOURCE" });
    await h.session.setModel(modelNamed("gpt-6-sol"));
    await h.session.prompt("NO IMPLICIT RESTORATION");
    assert.equal(h.bodies.length, calls);
    assert.match(h.notices.join("\n"), /edited|invalid/);
  });
});

test("portable payloads cancel when their prepared history becomes stale", async t => {
  const h = await host(t);
  await h.session.compact();
  await h.session.setModel(modelNamed("gpt-6-sol"));
  await h.session.prompt("CACHE PORTABLE SUMMARY");
  const getAuth = h.runtime.getAuth.bind(h.runtime);
  let changed = false;
  t.mock.method(h.runtime, "getAuth", async (m, options) => {
    const result = await getAuth(m, options);
    if (options?.signal && !changed) { changed = true; h.sm.appendMessage(user("NEW CANONICAL TAIL")); }
    return result;
  });
  const calls = h.bodies.length;
  await h.session.prompt("STALE PORTABLE REQUEST");
  assert.equal(h.bodies.length, calls);
  await h.session.prompt("RETRY WITH PORTABLE SUMMARY");
  assert.equal(h.bodies.length, calls + 1);
  assert.match(JSON.stringify(h.bodies.at(-1)), /NEW CANONICAL TAIL/);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work|Metis Codex remote checkpoint/);
});

test("a different provider compacts a portable summary without recovering raw Codex history", async t => {
  const h = await host(t, { other: true });
  await h.session.compact();
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const targetModel = new ModelRegistry(h.runtime).find("other-codex", "other");
  await h.session.setModel({ ...targetModel, contextWindow: 32_000, maxTokens: 24_000 });
  h.sm.appendMessage(user("DOCUMENTED TAIL ".repeat(4_000)));
  h.sm.appendMessage(assistant("completed tail"));
  h.sm.appendMessage(user("OTHER TAIL"));
  const start = h.bodies.length;
  const result = await h.session.compact();
  assert.equal(h.bodies.length, start + 2);
  assert.equal(h.bodies.at(-1).input.some(i => i.type === "compaction_trigger" || i.type === "compaction"), false);
  assert.doesNotMatch(JSON.stringify(h.bodies.at(-1)), /old work/);
  assert.match(JSON.stringify(h.bodies.at(-1)), /OK/);
  assert.match(JSON.stringify(h.bodies.at(-1)), /DOCUMENTED TAIL/);
  assert.equal(result.summary, "OK");
  assert.equal(compactions(h).at(-1).details?.[key], undefined);
});

test("manual compaction on another provider cannot turn summary failure into raw recovery", async t => {
  const h = await host(t, { other: true, normalResponse: () => sse([completed([])]) });
  await h.session.compact();
  const { ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  await h.session.setModel(new ModelRegistry(h.runtime).find("other-codex", "other"));
  h.sm.appendMessage(user("KEPT OTHER PROVIDER TAIL"));
  const calls = h.bodies.length;
  await assert.rejects(h.session.compact(), /cancel/i);
  assert.equal(compactions(h).length, 1);
  assert.equal(h.bodies.length, calls + 1, "only the original model attempts to create portable text");
  assert.equal(h.bodies.at(-1).model, model.id);
  assert.equal(h.bodies.at(-1).input.filter(item => item.type === "compaction").length, 1);
  assert.match(h.notices.join("\n"), /empty or invalid/);
});
