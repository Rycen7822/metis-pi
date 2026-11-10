import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

test("native model configuration preserves per-model empty-tools history behavior", async t => {
  const dir = await mkdtemp(join(tmpdir(), "metis-empty-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let network = 0;
  t.mock.method(globalThis, "fetch", async () => { network++; throw new Error("NETWORK_DISABLED"); });
  const path = join(dir, "models.json");
  await writeFile(path, JSON.stringify({ providers: { fixture: {
    api: "openai-completions", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic",
    models: [
      { id: "plain", contextWindow: 8192, maxTokens: 256 },
      { id: "legacy", contextWindow: 8192, maxTokens: 256, compat: { requiresToolsWithToolHistory: true } },
    ],
  } } }));
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: path,
    modelsStorePath: join(dir, "models-store.json"), refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  assert.equal(registry.getError(), undefined, "the documented model configuration loads without credentials or network");
  const first = { role: "user", content: "use the tool", timestamp: 100 };
  const history = [first, {
    role: "assistant", provider: "fixture", model: "plain", api: "openai-completions", timestamp: 101,
    content: [{ type: "toolCall", id: "call_fixture", name: "noop", arguments: {} }], stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, { role: "toolResult", toolCallId: "call_fixture", toolName: "noop", timestamp: 102,
    content: [{ type: "text", text: "done" }], isError: false }];
  const tool = { name: "noop", description: "fixture tool", parameters: { type: "object", properties: {} } };
  const payload = async (id, messages, tools) => {
    const model = registry.find("fixture", id);
    assert.ok(model, `configured model ${id} must be available`);
    let body;
    const result = await runtime.streamSimple(model, { messages, tools }, { apiKey: "synthetic",
      onPayload(value) { body = value; throw new Error("OFFLINE_PAYLOAD_CAPTURE"); } }).result();
    assert.ok(body, `the native provider must build its request: ${result.errorMessage ?? result.stopReason}`);
    return body;
  };
  for (const id of ["plain", "legacy"]) {
    assert.equal(Object.hasOwn(await payload(id, [first], []), "tools"), false, "a first turn does not need empty tools");
    const empty = await payload(id, history, []);
    if (id === "legacy") assert.deepEqual(empty.tools, []);
    else assert.equal(Object.hasOwn(empty, "tools"), false, "standard/vLLM paths omit the absent tool set");
    const active = await payload(id, history, [tool]);
    assert.equal(active.tools.length, 1);
    assert.equal(active.tools[0].function.name, "noop");
  }
  assert.equal(Object.hasOwn(await payload("plain", history, undefined), "tools"), false,
    "switching away from the legacy model must not leak its compatibility option");
  assert.deepEqual((await payload("legacy", history, undefined)).tools, []);
  assert.equal(network, 0, "request construction was captured before transport; no real gateway was contacted");
});
