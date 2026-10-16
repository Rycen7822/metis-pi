import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { projectArguments } from "../../src/condense/argument-history.ts";

test("argument projections share only immutable-snapshot hashes and revalidate in-place edits", () => {
  const messages = [
    { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "write", name: "write",
      arguments: { path: "file.ts", content: "original code".repeat(500) } }] },
    { role: "toolResult", timestamp: 2, toolCallId: "write", toolName: "write", isError: false,
      content: [{ type: "text", text: "ok" }] },
  ];
  const group = { version: 1, sourceIds: ["a", "b"], keys: ["write@2"], text: "Historical write arguments",
    fingerprints: messages.map(message => createHash("sha256").update(JSON.stringify(message)).digest("hex")) };
  const protection = { protectedTools: [], protectedPaths: [] };
  const cache = new WeakMap();
  const expected = projectArguments(messages, [group], protection);
  assert.notEqual(expected, messages);
  assert.deepEqual(projectArguments(messages, [group], protection, cache), expected);
  assert.deepEqual(projectArguments(messages, [group], protection, cache), expected);
  messages[0].content[0].arguments.content = "edited after that synchronous projection";
  assert.equal(projectArguments(messages, [group], protection), messages,
    "a new projection must never accept a cached fingerprint for mutated source");
});
