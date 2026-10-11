import test from "node:test";
import assert from "node:assert/strict";
import { record, queryFixture } from "../helpers/condense-query.mjs";
import { pruneMessages } from "../../src/condense/pruner.ts";
import { hashToolResult } from "../../src/condense/content-hash.ts";
import { DEFAULT_CONFIG } from "../../src/condense/types.ts";
import { modelNamed } from "../helpers/native-provider.mjs";
import { assistantToolCall, toolResult } from "../helpers/vendor-codex-sessions.mjs";

test("recall pages round-trip Unicode, long lines, all repeated-ID occurrences and error status within one total budget", async () => {
  const a = '\uFEFFstart\\\n"中文😀\t'.repeat(3000) + "MIDDLE_FAILURE" + "末尾".repeat(7000);
  const b = "second occurrence";
  const f = queryFixture([record("same", a, 3, { isError: true, args: { huge: "x".repeat(10000) } }), record("same", b, 5)]);
  let cursor;
  const collected = new Map();
  let pages = 0;
  do {
    const result = await f.run({ toolCallIds: ["same"], maxBytes: 2048, cursor });
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 2048);
    const body = JSON.parse(text);
    assert.deepEqual(result.details, body);
    for (const page of body.results) {
      assert.equal(page.error, undefined);
      const prior = collected.get(page.occurrence) ?? "";
      assert.equal(page.offsetBytes, Buffer.byteLength(prior));
      collected.set(page.occurrence, prior + page.text);
      assert.equal(page.status, page.occurrence === "same@3" ? "ERROR" : "OK");
    }
    cursor = body.nextCursor;
    assert.equal(body.eof, cursor === null);
    assert.ok(++pages < 500);
  } while (cursor);
  assert.equal(collected.get("same@3"), a);
  assert.equal(collected.get("same@5"), b);
  assert.ok(pages > 2);
});

test("cursor survives index reconstruction, rejects another session/branch and honors cancellation", async () => {
  const f = queryFixture([record("original", "large😀".repeat(5000))]);
  const first = await f.run({ toolCallIds: ["original"], maxBytes: 2048 });
  const cursor = first.details.nextCursor;
  assert.ok(cursor);
  f.indexer.reconstructFromSession(f.ctx);
  const next = await f.run({ toolCallIds: ["original"], maxBytes: 2048, cursor });
  assert.equal(next.details.results[0].offsetBytes, Buffer.byteLength(first.details.results[0].text));
  const other = queryFixture([record("original", "large😀".repeat(5000))]);
  await assert.rejects(other.run({ toolCallIds: ["original"], cursor }), /no longer matches/);
  f.ctx.sessionManager.branch(f.origin);
  f.indexer.reconstructFromSession(f.ctx);
  await assert.rejects(f.run({ toolCallIds: ["original"], cursor }), /no longer matches/);
  await assert.rejects(f.run({ toolCallIds: ["original"], cursor: "garbage" }), /Invalid recall cursor/);
  await assert.rejects(f.run({ toolCallIds: ["original"] }, AbortSignal.abort()), /abort/i);
});

test("legacy records, persisted short refs and dedup aliases remain recoverable after reconstruction and compaction", async () => {
  const legacy = record("legacy", "LEGACY_BODY", undefined);
  delete legacy.resultTimestamp;
  const f = queryFixture([legacy, record("same", "FIRST_BODY", 3), record("same", "SECOND_BODY", 5)]);
  const refs = [{ shortId: "t1", toolCallId: "same", resultTimestamp: 3 }, { shortId: "t2", toolCallId: "same", resultTimestamp: 5 }];
  f.ctx.sessionManager.appendCustomEntry("context-prune-index", { toolCalls: [], backfilled: true, refs });
  f.indexer.registerSummaryRefs(refs);
  f.indexer.registerDuplicate("duplicate@8", "same@3", (type, data) => f.ctx.sessionManager.appendCustomEntry(type, data));
  f.ctx.sessionManager.appendCompaction("capacity summary", f.origin, 1000);
  f.indexer.reconstructFromSession(f.ctx);
  const body = (await f.run({ toolCallIds: ["legacy", "t1", "t2", "duplicate@8"] })).details;
  assert.deepEqual(body.results.map((page) => page.text), ["LEGACY_BODY", "FIRST_BODY", "SECOND_BODY", "FIRST_BODY"]);
  assert.equal(body.results[0].occurrence, "legacy");
  assert.equal(body.results[0].legacy, true);
  assert.equal(body.eof, true);
});

test("recovery grace preserves the returned page without reintroducing the source log", async () => {
  const f = queryFixture([record("raw", "BIG_SOURCE".repeat(5000))]);
  const response = await f.run({ toolCallIds: ["raw"], maxBytes: 2048 });
  const page = response.content[0].text;
  const recovery = record("query", page, 9, { toolName: "context_tree_query", args: { toolCallIds: ["raw"] } });
  f.ctx.sessionManager.appendCustomEntry("context-prune-index", { toolCalls: [recovery] });
  f.indexer.reconstructFromSession(f.ctx);
  const model = modelNamed("gpt-6-astra");
  const messages = [{ role: "user", content: "inspect", timestamp: 1 }, assistantToolCall(model, "raw", "read"), toolResult("raw", "read", "BIG_SOURCE".repeat(5000), 3), assistantToolCall(model, "query", "context_tree_query"), toolResult("query", "context_tree_query", page, 9)];
  const projected = pruneMessages(messages, f.indexer, undefined, undefined, undefined, 3).messages;
  assert.ok(projected.find((m) => m.toolCallId === "raw").content[0].text.length < 1000);
  assert.equal(projected.find((m) => m.toolCallId === "query").content[0].text, page);
  assert.deepEqual(DEFAULT_CONFIG.chainCompression, { enabled: true, rollingWindow: 3, stripFinalAssistantThinking: true, fuseRangeSummary: true });
});

test("duplicate body recall keeps each command, status, timestamp and short ref after reload", async () => {
  const first = record("first", "same output", 3, { toolName: "bash", args: { command: "test-a" } });
  const second = record("second", "same output", 8, { toolName: "bash", args: { command: "test-b" }, isError: true });
  const f = queryFixture([first]);
  f.indexer.registerDuplicate("second@8", "first@3", (type, data) => f.ctx.sessionManager.appendCustomEntry(type, data), second);
  const ref = f.indexer.getShortRefForToolCallId("second@8");
  f.indexer.reconstructFromSession(f.ctx);
  assert.deepEqual(f.indexer.getRecord(ref), second);
  const page = (await f.run({ toolCallIds: [ref] })).details.results[0];
  assert.equal(page.status, "ERROR");
  assert.deepEqual(JSON.parse(page.argsPreview), { command: "test-b" });
  assert.equal(page.occurrence, "second@8");
  assert.notEqual(hashToolResult("bash", "a  b"), hashToolResult("bash", "a b"));
});

test("legacy alias without its source reports unknown metadata and is not pruned", async () => {
  const f = queryFixture([record("first", "shared historic body")]);
  f.ctx.sessionManager.appendCustomEntry("context-prune-dedup-alias", { newToolCallId: "lost", newResultTimestamp: 8, originalToolCallId: "first", originalResultTimestamp: 3 });
  f.indexer.reconstructFromSession(f.ctx);
  const own = f.indexer.getRecord("lost@8");
  assert.equal(own?.metadataUnavailable, true);
  const page = (await f.run({ toolCallIds: ["lost@8"] })).details.results[0];
  assert.equal(page.status, "UNKNOWN");
  assert.match(page.error, /not verified output/);
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "lost", "read"), toolResult("lost", "read", "live source", 8)];
  assert.equal(pruneMessages(messages, f.indexer).messages[1], messages[1]);
});

test("recall pages original arguments and branch-owned summaries with content-bound cursors", async () => {
  const { ctx, indexer, run } = queryFixture([]);
  const args = { path: "historical.ts", content: "🙂原文\n".repeat(6000) };
  indexer.addBatch({ turnIndex: 1, timestamp: 2, toolCalls: [{ toolCallId: "write", toolName: "write", args, resultText: "done", isError: false, resultTimestamp: 3 }] }, () => {});
  const query = params => run(params).then(r => r.details);
  const params = { toolCallIds: ["write@3"], component: "arguments", maxBytes: 2048 };
  const first = await query(params);
  assert.equal(first.results[0].source, "tool-arguments");
  await assert.rejects(query({ ...params, component: "output", cursor: first.nextCursor }), /cursor no longer matches/i);
  let page = first, text = first.results[0].text;
  while (page.nextCursor) { page = await query({ ...params, cursor: page.nextCursor }); text += page.results[0].text; }
  assert.equal(text, JSON.stringify(args));
  ctx.sessionManager.appendCustomMessageEntry("context-prune-summary", "DERIVED_HISTORY ".repeat(1000), false, {});
  const entry = ctx.sessionManager.getBranch().at(-1);
  page = await query({ sourceEntryIds: [entry.id], maxBytes: 2048 }); text = page.results[0].text;
  while (page.nextCursor) { page = await query({ sourceEntryIds: [entry.id], maxBytes: 2048, cursor: page.nextCursor }); text += page.results[0].text; }
  assert.deepEqual(JSON.parse(text), entry);
  assert.match((await query({ sourceEntryIds: ["missing"] })).results[0].error, /Not found/);
  await assert.rejects(query({ sourceEntryIds: [entry.id], ...params }), /Choose sourceEntryIds/);
});

test("summary readers preserve occurrence ownership, first-seen body order and legacy refs across reload", () => {
  const { indexer, ctx } = queryFixture([]);
  const ref = (shortId, toolCallId, resultTimestamp) => ({ shortId, toolCallId, resultTimestamp });
  const first = ref("t1", "same", 3), second = ref("t2", "same", 5), outside = ref("t3", "outside", 9);
  for (const [content, details] of [
    ["EARLY", { toolCallRefs: [first] }],
    ["LATE", { toolCallRefs: [first] }],
    ["EARLY", { toolCallRefs: [second] }],
    [[{ type: "text", text: "MIXED" }], { toolCallRefs: [first, outside] }],
    ["LEGACY", { toolCallIds: ["legacy"] }],
  ]) ctx.sessionManager.appendCustomMessageEntry("context-prune-summary", content, false, details);

  const checkReaders = () => {
    assert.equal(indexer.hasPerBatchSummaryCoveringAny([]), false);
    assert.equal(indexer.hasPerBatchSummaryCoveringAny(["same@3"]), true);
    assert.equal(indexer.hasPerBatchSummaryCoveringAny(["same@5"]), true);
    assert.equal(indexer.hasPerBatchSummaryCoveringAny(["same"]), false, "a bare id is not an occurrence wildcard");
    assert.deepEqual(indexer.getPerBatchSummariesForToolCallIds(["same@3", "same@5"]), ["EARLY", "LATE", "MIXED"]);
    assert.deepEqual(indexer.getPerBatchSummariesForToolCallIds(["same@5"]), ["EARLY"]);
    assert.equal(indexer.getPerBatchSummaryTextForToolCallIds(["same@3"]), "EARLY\n\nLATE\n\nMIXED");
    assert.equal(indexer.getOwnedSummaryText(["same@3"]), null, "a mixed semantic summary cannot be split by refs");
    assert.equal(indexer.getOwnedSummaryText(["same@5"]), "EARLY");
    assert.equal(indexer.getOwnedSummaryText(["same@3", "outside@9"]), "EARLY\n\nLATE\n\nMIXED");
    assert.equal(indexer.getOwnedSummaryText(["legacy"]), "LEGACY");
    assert.deepEqual(indexer.getPerBatchSummariesForToolCallIds([]), []);
    assert.equal(indexer.getOwnedSummaryText(["absent"]), "");
  };
  indexer.syncSummaryEntries(ctx);
  checkReaders();
  indexer.reconstructFromSession(ctx);
  checkReaders();
});
