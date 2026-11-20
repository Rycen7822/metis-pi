import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { combineSummaryMessages, retainSummaryGroup, summaryGroupMembers } from "../../src/condense/summary-refs.ts";
import { ToolCallIndexer } from "../../src/condense/indexer.ts";
import { occKey } from "../../src/condense/occurrence-key.ts";

const ref = (shortId, toolCallId, resultTimestamp) => ({ shortId, toolCallId, resultTimestamp });
const summary = (content, refs) => ({ content,
  details: { toolCallRefs: refs, toolNames: refs.map(() => "read"), turnIndex: 0, timestamp: 1 } });
const group = () => combineSummaryMessages([
  summary("Alpha evidence 汉字🙂", [ref("t1", "same", 10), ref("t2", "other", 11)]),
  summary("Beta evidence", [ref("t3", "same", 20)]),
]);

test("summary groups store one body and exact occurrence-owned UTF16 spans", () => {
  const message = group(), members = summaryGroupMembers(message);
  assert.equal(members.length, 2);
  assert.equal(message.content, "Alpha evidence 汉字🙂\n\nBeta evidence");
  assert.equal(message.content.slice(members[0].bodyStart, members[0].bodyEnd), "Alpha evidence 汉字🙂");
  assert.equal(message.content.slice(members[1].bodyStart, members[1].bodyEnd), "Beta evidence");
  assert.equal("text" in message.details.members[0], false, "do not duplicate bodies in metadata");
  assert.deepEqual(members[0].toolCallRefs.map(item => item.resultTimestamp), [10, 11]);
});

test("partial group projection retains complete semantic members and rebuilds surviving ownership", () => {
  const message = group();
  message.details.toolNames = ["read", "bash", "grep"];
  assert.equal(retainSummaryGroup(message, () => false), null);
  assert.deepEqual(retainSummaryGroup(message, item => item.resultTimestamp !== 10), message,
    "a member with another surviving ref cannot be split or discarded");
  const retained = retainSummaryGroup(message, item => item.resultTimestamp === 20);
  assert.equal(retained.content, "Beta evidence");
  assert.deepEqual(retained.details.toolCallRefs, [ref("t3", "same", 20)]);
  assert.deepEqual(retained.details.toolNames, ["grep"], "tool names remain aligned with the retained refs");
  assert.deepEqual(summaryGroupMembers(retained), [{ toolCallRefs: [ref("t3", "same", 20)], bodyStart: 0, bodyEnd: 13 }]);
  assert.equal(message.content, "Alpha evidence 汉字🙂\n\nBeta evidence", "projection does not mutate the durable source");
  message.details.toolCallRefs.reverse(); message.details.toolNames.reverse();
  assert.deepEqual(retainSummaryGroup(message, item => item.resultTimestamp === 20).details.toolNames, ["grep"]);
});

test("malformed member boundaries or refs remain unsplittable rather than inventing ownership", () => {
  const edits = [
    message => { message.details.members[0].bodyEnd++; },
    message => { message.details.members[1].bodyStart--; },
    message => { message.details.members[1].bodyEnd--; },
    message => { message.details.members[1].toolCallRefs = [ref("t1", "same", 10)]; },
    message => { message.details.members[1].toolCallRefs = [ref("wrong", "same", 20)]; },
    message => { message.details.members[1].toolCallRefs[0].resultTimestamp = NaN; },
    message => { message.details.toolCallRefs.push(ref("t4", "missing", 30)); },
    message => { message.content = "prefix" + message.content; },
  ];
  for (const edit of edits) {
    const message = group(); edit(message);
    assert.equal(summaryGroupMembers(message), undefined);
    assert.equal(retainSummaryGroup(message, () => true), undefined);
  }
  assert.equal(summaryGroupMembers(summary("Legacy evidence", [ref("t1", "same", 10)])), undefined);
});

test("index replay recovers individual group bodies but refuses to split legacy semantic summaries", () => {
  const message = group();
  for (const legacy of [false, true]) {
    const details = structuredClone(message.details);
    if (legacy) delete details.members;
    const indexer = new ToolCallIndexer();
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendCustomMessageEntry("context-prune-summary", message.content, false, details);
    indexer.syncSummaryEntries({ sessionManager });
    assert.equal(indexer.getOwnedSummaryText([occKey("same", 20)]), legacy ? null : "Beta evidence");
    assert.equal(indexer.getOwnedSummaryText([occKey("same", 10)]), null, "one semantic member remains indivisible");
    assert.equal(indexer.getOwnedSummaryText([occKey("same", 10), occKey("other", 11)]),
      legacy ? null : "Alpha evidence 汉字🙂");
  }
});
