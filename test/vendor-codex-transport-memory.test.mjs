import assert from "node:assert/strict";
import test from "node:test";
import * as zlib from "node:zlib";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createCodexTransportStream } from "../vendor/pi-codex-conversion/dist/providers/openai-codex/transport-recovery.js";

const model = { ...getBuiltinModels("openai-codex")[0], baseUrl: "http://127.0.0.1:1" };
const apiKey = "x." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "offline-memory-test" },
})).toString("base64url") + ".x";
const completed = { type: "response.completed", response: {
  id: "offline-response", status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
} };

for (const transport of ["websocket", "sse", "fallback"]) {
  test(`Codex ${transport}: only encode/compress an SSE body when needed`, async (t) => {
    let compressions = 0;
    let serializations = 0;
    let fetches = 0;
    let wsRequests = 0;
    const body = { model: model.id, input: [{ role: "user", content: "hello 中文" }], stream: true, store: false };
    Object.defineProperty(body, "toJSON", { value() { serializations++; return { ...body }; } });
    const builtin = process.getBuiltinModule.bind(process);
    t.mock.method(process, "getBuiltinModule", (name) => name === "node:zlib" ? {
      ...builtin(name),
      zstdCompressSync: (json, options) => { compressions++; return zlib.zstdCompressSync(json, options); },
    } : builtin(name));

    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        if (transport === "fallback") throw new Error("Unexpected server response: 426");
        setImmediate(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
      }
      send(payload) {
        wsRequests++;
        assert.deepEqual(JSON.parse(payload), { type: "response.create", ...body });
        setImmediate(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completed) })));
      }
      close() { this.readyState = 3; }
    };
    t.after(() => { globalThis.WebSocket = previousWebSocket; });
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      fetches++;
      assert.equal(new Headers(options.headers).get("content-encoding"), "zstd");
      assert.deepEqual(JSON.parse(zlib.zstdDecompressSync(options.body).toString()), { ...body });
      return new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });

    const stream = createCodexTransportStream(model, { messages: [], tools: [] }, {
      apiKey, transport: transport === "sse" ? "sse" : "websocket", env: { NO_PROXY: "*" },
      maxRetries: 0, timeoutMs: 1000, websocketConnectTimeoutMs: 1000,
    }, { prepareRequestBody: async () => body });
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(compressions, transport === "websocket" ? 0 : 1);
    assert.equal(fetches, transport === "websocket" ? 0 : 1);
    assert.equal(wsRequests, transport === "websocket" ? 1 : 0);
    // Fallback also serializes once for the failed-WebSocket diagnostic.
    assert.equal(serializations, transport === "websocket" ? 0 : transport === "sse" ? 1 : 2);
  });
}
