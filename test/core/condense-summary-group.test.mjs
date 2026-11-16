import assert from "node:assert/strict";
import test from "node:test";
import { SummaryGroupAttempts, summaryGroupSource } from "../../src/condense/summary-group.ts";

function manager() {
  const entries = [], bodies = [];
  const reader = {
    getLeafId: () => entries.at(-1)?.id,
    getEntryMetadata: id => {
      const entry = entries.find(item => item.id === id);
      return entry?.type === "message" ? { ...entry, message: { role: entry.message.role } } : entry;
    },
    getEntry: id => { bodies.push(id); return entries.find(entry => entry.id === id); },
  };
  const append = (type, data) => entries.push({ ...data, type, id: `e${entries.length}`, parentId: entries.at(-1)?.id });
  return { reader, entries, bodies, append,
    control: (customType, data) => append("custom", { customType, data }) };
}

test("summary group source is stable across pending/persisted checkpoints and later non-message triggers without reading old bodies", () => {
  const m = manager();
  m.append("message", { message: { role: "toolResult", timestamp: 1, content: "old output" } });
  const closing = { role: "assistant", content: [{ type: "text", text: "Complete" }], timestamp: 2 };
  const pending = summaryGroupSource(m.reader, closing);
  assert.equal(m.bodies.length, 0);
  m.control("context-prune-group-attempt", { key: "x".repeat(64) });
  m.control("context-prune-flush-metrics", {});
  assert.equal(summaryGroupSource(m.reader, closing), pending);
  m.append("message", { message: closing });
  assert.equal(summaryGroupSource(m.reader, closing), pending);
  assert.equal(summaryGroupSource(m.reader), pending, "a recovery/budget trigger is the same visible source");
  closing.usage = { input: 1000 }; closing.stopReason = "stop";
  assert.equal(summaryGroupSource(m.reader, closing), pending, "usage bookkeeping is not new model-visible work");
  assert.ok(m.bodies.every(id => id !== "e0"), "old payload identity belongs to the host, not a content hash");
  m.append("context_edit", { targetId: "e0" });
  assert.notEqual(summaryGroupSource(m.reader, closing), pending);
});

test("persisted group intents survive a fresh owner, successful publication resolves them, and branch restore bounds replay", () => {
  const m = manager(), first = new SummaryGroupAttempts();
  const key = "a".repeat(64);
  first.begin(key, m.control);
  const restored = new SummaryGroupAttempts(); restored.restore(m.reader);
  assert.equal(restored.has(key), true);
  restored.resolve(key, m.control);
  const completed = new SummaryGroupAttempts(); completed.restore(m.reader);
  assert.equal(completed.has(key), false);
  for (let i = 0; i < 40; i++) completed.begin(i.toString(16).padStart(64, "0"), m.control);
  const reopened = new SummaryGroupAttempts(); reopened.restore(m.reader);
  assert.equal(reopened.has("0".repeat(64)), false);
  assert.equal(reopened.has((39).toString(16).padStart(64, "0")), true);
  reopened.begin("b".repeat(64), m.control);
  assert.equal(reopened.has((39).toString(16).padStart(64, "0")), true, "replay must not reverse eviction recency");
  assert.equal(reopened.has((8).toString(16).padStart(64, "0")), false);
  m.entries.length = 0; reopened.restore(m.reader);
  assert.equal(reopened.has((39).toString(16).padStart(64, "0")), false, "never carry a latch into another branch");
});

test("a failed group-intent append propagates before provider work and leaves a conservative in-memory latch", () => {
  const attempts = new SummaryGroupAttempts(), key = "a".repeat(64);
  assert.throws(() => attempts.begin(key, () => { throw new Error("journal full"); }), /journal full/);
  assert.equal(attempts.has(key), true);
});
