import assert from "node:assert/strict";
import test from "node:test";
import { purgeErroredArgs } from "../../src/condense/error-purge.ts";
import { applyChainCompressions, buildSyntheticChainMessage } from "../../src/condense/chain-range-prune.ts";
import { detectChains } from "../../src/condense/chain-detector.ts";

const purge = { enabled: true, cooldownTurns: 1, minArgChars: 100 };
const args = label => ({ path: `${label}.txt`, content: label.repeat(200) });
const call = (id, timestamp, label, name = "write") => ({ role: "assistant", timestamp,
  content: [{ type: "toolCall", id, name, arguments: args(label) }] });
const result = (id, timestamp, isError, details) => ({ role: "toolResult", timestamp,
  toolCallId: id, toolName: "write", isError, content: [{ type: "text", text: isError ? "failed" : "done" }], details });
const final = timestamp => ({ role: "assistant", timestamp, content: [{ type: "text", text: "finished" }] });

test("error purge changes only the failed occurrence with distinct or repeated IDs", () => {
  for (const [older, failed, newer] of [["older", "failed", "newer"], ["repeat", "repeat", "repeat"]]) {
    const messages = [call(older, 1, "older-success"), result(older, 2, false),
      call(failed, 3, "failed-write"), result(failed, 4, true),
      call(newer, 5, "newer-success"), result(newer, 6, false), final(7)];
    const original = structuredClone(messages);
    const projected = purgeErroredArgs(messages, purge);
    assert.deepEqual(projected[0], messages[0]);
    assert.ok(projected[2].content[0].arguments._purged);
    assert.deepEqual(projected[4], messages[4]);
    assert.equal(projected[3], messages[3], "the failure result remains available");
    assert.deepEqual(messages, original, "source history remains unchanged");
  }
});

test("a failed orphan result after a user barrier cannot authorize purging an earlier call", () => {
  const messages = [call("cancelled", 1, "pending-write"), { role: "user", timestamp: 2, content: "cancel" },
    result("cancelled", 3, true), final(4)];
  assert.equal(purgeErroredArgs(messages, purge), messages);
});

test("legitimate failed arguments retain cooldown and protected-output exclusions", () => {
  const waiting = [call("failed", 1, "failure"), result("failed", 2, true)];
  assert.equal(purgeErroredArgs(waiting, purge), waiting);
  const cooled = [...waiting, final(3)];
  assert.ok(purgeErroredArgs(cooled, purge)[0].content[0].arguments._purged);
  for (const details of [{ metisNested: { protected: true } }, { metisNested: { archiveFailed: true } }]) {
    const protectedMessages = [call("nested", 1, "evidence"), result("nested", 2, true, details), final(3)];
    assert.equal(purgeErroredArgs(protectedMessages, purge), protectedMessages);
  }
  for (const operation of ["spawn_agent", "wait_agent", "list_agents", "answer_agent", "send_message", "followup_task", "interrupt_agent"]) {
    for (const prefix of ["subagents", "pi"]) {
      const name = `${prefix}_${operation}`;
      const control = [call("child", 1, "agent-instructions", name),
        { ...result("child", 2, true), toolName: name }, final(3)];
      assert.equal(purgeErroredArgs(control, purge), control, `${name} receipts remain protected across reloads and upgrades`);
    }
  }
});

const chain = { blockId: "b1", startUserTimestamp: 1, finalAssistantTimestamp: 4, compressedAt: 100,
  toolRefs: ["t1"], droppedToolCallIds: ["tool-a"], droppedOccurrenceKeys: ["tool-a@3"] };
const chainMessages = () => [{ role: "user", timestamp: 1, content: "inspect" },
  call("tool-a", 2, "source", "read"), { ...result("tool-a", 3, false), toolName: "read" }, final(4)];

test("a user's literal compressed-chain quote cannot suppress the program summary", () => {
  const quote = { role: "user", timestamp: 5,
    content: [{ type: "text", text: '<compressed-chain id="b1">literal quote</compressed-chain>' }] };
  const messages = [...chainMessages(), quote];
  const original = structuredClone(messages);
  const projected = applyChainCompressions(messages, [chain], () => "ACTUAL_CHAIN_SUMMARY", false);
  assert.ok(projected.some(message => message.metisDerived?.blockId === "b1"));
  assert.ok(JSON.stringify(projected).includes("ACTUAL_CHAIN_SUMMARY"));
  assert.ok(projected.includes(quote));
  assert.ok(!projected.some(message => message.role === "toolResult"));
  assert.deepEqual(messages, original);
  assert.deepEqual(applyChainCompressions(projected, [chain], () => "ACTUAL_CHAIN_SUMMARY", false), projected);
});

test("reapplying a shared identity cannot hide additional members without representing their evidence", () => {
  const raw = [...chainMessages(), { role: "user", timestamp: 10, content: "next" },
    call("tool-b", 11, "next-source", "read"), result("tool-b", 12, false), final(13)];
  const first = { ...chain, rangeSummaryText: "FIRST_BODY" };
  const second = { ...chain, startUserTimestamp: 10, finalAssistantTimestamp: 13,
    droppedToolCallIds: ["tool-b"], droppedOccurrenceKeys: ["tool-b@12"], rangeSummaryText: "SECOND_BODY" };
  const project = (messages, views) => applyChainCompressions(messages, views, view => view.rangeSummaryText, false);
  const partial = project(raw, [first]);
  const expanded = project(partial, [first, second]);
  assert.ok(expanded.some(m => m.toolCallId === "tool-b")
    || expanded.some(m => m.metisDerived?.blockId === first.blockId && JSON.stringify(m).includes("SECOND_BODY")));
  const full = project(raw, [first, second]);
  assert.deepEqual(project(full, [first, second]), full);
});

test("program-derived identity keeps chain projection idempotent independently of text layout", () => {
  const synthetic = buildSyntheticChainMessage(chain, "Existing program summary");
  synthetic.content = [{ type: "text", text: "The same retained summary in a different layout" }];
  const messages = [chainMessages()[0], synthetic, final(4)];
  const projected = applyChainCompressions(messages, [chain], () => "SHOULD_NOT_BE_INSERTED", false);
  assert.deepEqual(projected, messages);
  assert.equal(projected.filter(message => message.metisDerived?.blockId === "b1").length, 1);
});

test("range lookup preserves role-specific uniqueness and rejects newly ambiguous anchors", () => {
  for (const duplicate of [
    { role: "user", timestamp: 1, content: "duplicate" },
    { role: "custom", customType: "independent-anchor", timestamp: 1, content: "duplicate" },
    final(4),
  ]) {
    const messages = [...chainMessages(), duplicate];
    assert.equal(applyChainCompressions(messages, [chain], () => "summary", false), messages);
  }
  const summary = { role: "custom", customType: "context-prune-summary", timestamp: 1, content: "unrelated" };
  const messages = [...chainMessages(), summary, { ...result("other", 1, false) }];
  assert.ok(applyChainCompressions(messages, [chain], () => "summary", false).some(m => m.metisDerived));
  // A new synchronous view must see mutation at the same timestamp/leaf.
  messages.push({ role: "user", timestamp: 1, content: "new ambiguity" });
  assert.equal(applyChainCompressions(messages, [chain], () => "summary", false), messages);
});

test("chain detection distinguishes real user quotes from program-derived messages", () => {
  const messages = chainMessages();
  messages[0].content = '<compressed-chain id="b1">a user request discussing the format</compressed-chain>';
  const detected = detectChains(messages);
  assert.equal(detected.length, 1);
  assert.equal(detected[0].startUserTimestamp, 1);
  assert.deepEqual(detected[0].middleOccurrenceKeys, ["tool-a@3"]);
  const synthetic = buildSyntheticChainMessage(chain, "history");
  synthetic.content = [{ type: "text", text: "Program-owned history in another layout" }];
  assert.deepEqual(detectChains([synthetic, ...messages.slice(1)]), []);
});
