import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { GoalState } from "../../src/goal-state.ts";
import { FAKE_API_KEY, modelNamed } from "../helpers/native-provider.mjs";

test("Goal accounts the native SDK's uncached input plus output exactly once", async () => {
  const item = { type: "message", id: "audit-msg", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "audit-r", status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "audit-r", status: "completed", output: [item], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 75 }, output_tokens: 5, total_tokens: 105 } } },
  ];
  const message = await streamSimple(modelNamed("gpt-6-astra"), normalizeContext({ messages: [{ role: "user", content: "finish", timestamp: 0 }] }), {
    apiKey: FAKE_API_KEY, transport: "sse", maxRetries: 0,
    fetch: async () => new Response(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }),
  }).result();
  assert.equal(message.stopReason, "stop");
  assert.deepEqual([message.usage.input, message.usage.cacheRead, message.usage.output], [25, 75, 5]);
  const state = new GoalState();
  state.create("finish", 30); state.startTurn(); state.accountTurn([message]); state.finishTurn();
  assert.equal(state.current!.tokensUsed, 30);
  assert.equal(state.current!.status, "budgetLimited");
});

test("fully cached measured usage is zero while legacy total-only usage remains countable", () => {
  const state = new GoalState(); state.create("keep accurate usage"); state.startTurn();
  state.accountTurn([{ role: "assistant", usage: { input: 0, output: 0, cacheRead: 100, totalTokens: 100 } }]);
  assert.equal(state.current!.tokensUsed, 0);
  state.accountTurn([{ role: "assistant", usage: { totalTokens: 7 } }]);
  assert.equal(state.current!.tokensUsed, 7);
});
