import assert from "node:assert/strict";
import test from "node:test";
import initialize from "../../extensions/model-catalog.ts";

const privateText = "synthetic-private-stream-data";
const args = JSON.stringify({ code: privateText });

test("Responses diagnostics opt in, report boundaries without payloads, and clear on branch change", async t => {
  const hooks = new Map(), providers = new Map();
  let notice, command;
  await initialize({
    on(name, handler) { hooks.set(name, handler); },
    registerProvider(provider) { providers.set(provider.id, provider); },
    registerCommand(name, options) { if (name === "responses-stream") command = options.handler; },
  });
  const invoke = async (value = "") => {
    await command(value, { ui: { notify(message) { notice = message; } } });
    return notice;
  };
  const provider = providers.get("openai");
  const model = provider.getModels().find(model => model.api === "openai-responses");
  assert.ok(model);
  const item = { type: "function_call", id: "item-private", call_id: "call-private", name: "codemode", arguments: "" };
  const events = [
    { type: "response.created", response: { id: "response-private" } },
    { type: "response.output_item.added", item, output_index: 0 },
    { type: "response.function_call_arguments.delta", delta: args, output_index: 0 },
    { type: "response.function_call_arguments.done", arguments: args, output_index: 0 },
    { type: privateText },
  ];
  const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  const fetch = async () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const run = async () => provider.streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] },
    { fetch, apiKey: "synthetic-local-key", signal: AbortSignal.timeout(2_000), maxRetries: 0 }).result();
  assert.equal((await run()).stopReason, "error");
  assert.match(await invoke(), /diagnostics off/);
  assert.match(await invoke("on"), /No OpenAI HTTP Responses request captured/);
  for (let i = 0; i < 5; i++) assert.equal((await run()).stopReason, "error");
  const report = await invoke();
  assert.equal(report.match(/error after \d+ms/g)?.length, 4, "bounds the number of recorded requests");
  assert.ok(report.includes(`5 parsed events; ${Buffer.byteLength(args)} argument delta bytes`));
  assert.match(report, /Last event: other \+\d+ms; last argument progress: args\.delta #0 \+\d+ms/);
  assert.match(report, /args\.done #0 \+\d+ms/);
  assert.doesNotMatch(report, /completed|synthetic-private|response-private|item-private|call-private|codemode/);
  hooks.get("session_tree")();
  assert.match(await invoke(), /No OpenAI HTTP Responses request captured/);
  hooks.get("session_shutdown")();
  assert.match(await invoke(), /diagnostics off/);
});
