import test from "node:test";
import assert from "node:assert/strict";
import { record, queryFixture } from "../helpers/condense-query.mjs";
import { pruneMessages } from "../../src/condense/pruner.ts";
import { findSuperseded } from "../../src/condense/supersede.ts";
import { modelNamed } from "../helpers/native-provider.mjs";
import { assistantToolCall, toolResult } from "../helpers/vendor-codex-sessions.mjs";

test("pruning a failed execution retains ERROR and its independent evidence reference", () => {
  const f = queryFixture([record("failed", "failure detail", 3, { isError: true })]);
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "failed", "read"),
    { ...toolResult("failed", "read", "failure detail"), isError: true }];
  const projected = pruneMessages(messages, f.indexer).messages;
  assert.equal(projected[1].isError, true);
  assert.match(projected[1].content[0].text, /status ERROR/);
  assert.match(projected[1].content[0].text, /ref `failed@3`/);
});

test("protected reads retain disjoint ranges, changed bytes and later failures", () => {
  const model = modelNamed("gpt-6-astra");
  const pair = (id, offset, text, isError = false) => [
    assistantToolCall(model, id, "read", { path: "/skills/a/SKILL.md", offset, limit: 80 }),
    { ...toolResult(id, "read", text), isError },
  ];
  const first = pair("first", 1, "instructions");
  for (const later of [pair("next", 81, "next page"), pair("next", 1, "changed instructions"), pair("next", 1, "instructions", true)]) {
    assert.deepEqual(findSuperseded([...first, ...later], () => true), []);
  }
  assert.deepEqual(findSuperseded([...first, ...pair("same", 1, "instructions")], () => true).map((c) => c.toolCallId), ["first"]);
});

test("legacy archive-only records never authorize pruning after rejected preparation or reload", () => {
  const legacy = record("legacy-only", "EXACT_LEGACY_OUTPUT");
  delete legacy.resultTimestamp;
  legacy.archiveOnly = true;
  const f = queryFixture([legacy]);
  const message = toolResult("legacy-only", "read", "EXACT_LEGACY_OUTPUT");
  delete message.timestamp;
  const messages = [assistantToolCall(modelNamed("gpt-6-astra"), "legacy-only", "read"), message];
  assert.equal(f.indexer.isSummarized("legacy-only"), false);
  assert.equal(f.indexer.hasLegacyBareRecord("legacy-only"), false);
  assert.equal(pruneMessages(messages, f.indexer).messages[1], message);
});
