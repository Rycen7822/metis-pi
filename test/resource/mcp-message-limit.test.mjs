import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { McpServerSession } from "../../src/mcp/session.ts";
import { CatalogCache } from "../../src/mcp/catalog.ts";
import { startHttp } from "../helpers/mcp-server.mjs";

const LIMIT = 16 * 1024 * 1024;

async function session(t) {
  const fixture = await startHttp(), dir = await mkdtemp(join(tmpdir(), "metis-mcp-limit-"));
  const owner = new McpServerSession({ name: "fixture", scope: "global", source: "fixture", config: { url: fixture.url } },
    dir, dir, { enabled: true, idleTimeoutSeconds: 60, keepAliveServers: [] }, new CatalogCache(dir),
    () => ({ cwd: dir, isIdle: () => true, isProjectTrusted: () => true }), () => {});
  t.after(async () => {
    try { await owner.shutdown(); await fixture.close(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  await owner.discover();
  const request = method => method === "tools/call"
    ? owner.callTool(owner.catalog.tools[0], owner.scope, { value: 1 }, {})
    : owner.resource("resources/read", { uri: "data://plain" });
  return { ...fixture, owner, request };
}

function resultFor(method, text) {
  return method === "tools/call" ? { content: [{ type: "text", text }] }
    : { contents: [{ uri: "data://plain", mimeType: "text/plain", text }] };
}

function bodyAtBytes(message, bytes) {
  const envelope = text => ({ jsonrpc: "2.0", id: message.id, result: resultFor(message.method, text) });
  const padding = bytes - Buffer.byteLength(JSON.stringify(envelope("")));
  const text = "界".repeat(Math.floor(padding / 3)) + "x".repeat(padding % 3);
  const body = Buffer.from(JSON.stringify(envelope(text)));
  assert.equal(body.length, bytes, "the fixture exercises UTF-8 response bytes, not JS string length");
  return body;
}

test("MCP tools and resources honor the JSON byte boundary, including Unicode", { timeout: 20000 }, async t => {
  for (const method of ["tools/call", "resources/read"]) for (const delta of [-1, 0, 1]) {
    await t.test(`${method}: limit ${delta >= 0 ? "+" : ""}${delta}`, async t => {
      const h = await session(t);
      let sent;
      h.state.reply = (message, _result, res) => {
        if (message.method !== method) return false;
        const body = bodyAtBytes(message, LIMIT + delta);
        sent = body.length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return true;
      };
      if (delta > 0) await assert.rejects(h.request(method), /MCP JSON response exceeds 16777216 bytes/);
      else {
        const result = await h.request(method);
        const text = method === "tools/call" ? result.content[0].text : result.contents[0].text;
        assert.ok(text.startsWith("界"), "successful transport retains multibyte text");
        assert.ok(Buffer.byteLength(text) > 20 * 1024, "the transport limit is not the display truncation limit");
      }
      assert.equal(sent, LIMIT + delta, "the intended reply reached the real HTTP fixture");
    });
  }
});

test("oversized MCP JSON cancels a streaming HTTP reply before its end", { timeout: 10000 }, async t => {
  const h = await session(t), planned = 4 * LIMIT, chunk = "x".repeat(64 * 1024);
  let sent = 0, closed, finished;
  h.state.reply = async (message, _result, res) => {
    if (message.method !== "tools/call") return false;
    const controller = new AbortController(), stop = () => controller.abort();
    res.once("close", stop);
    closed = once(res, "close", { signal: AbortSignal.timeout(5000) }).then(() => { finished = res.writableFinished; });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(`{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[{"type":"text","text":"`);
    try {
      while (sent < planned && !res.destroyed) {
        sent += chunk.length;
        if (!res.write(chunk)) await once(res, "drain", { signal: controller.signal });
      }
      if (!res.destroyed) res.end('"}]}}');
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally { res.off("close", stop); }
    return true;
  };
  await assert.rejects(h.request("tools/call"), /MCP JSON response exceeds 16777216 bytes/);
  await closed;
  assert.equal(finished, false, "the reply closed before a successful end, without fixture shutdown");
  assert.ok(sent < planned, "the client did not consume or queue the full oversized reply");
});

test("MCP SSE accepts CR, LF and CRLF across asynchronous UTF-8 fragments", async t => {
  for (const separator of ["\r", "\n", "\r\n"]) await t.test(JSON.stringify(separator), async t => {
    const h = await session(t);
    h.state.reply = async (message, _result, res) => {
      if (message.method !== "tools/call") return false;
      const body = Buffer.from(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: resultFor(message.method, "分片") })}${separator}${separator}`);
      const split = body.indexOf(Buffer.from("分")) + 1;
      const cuts = [0, split, body.length - separator.length - 1, body.length];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 1; i < cuts.length; i++) {
        res.write(body.subarray(cuts[i - 1], cuts[i]));
        await setImmediate();
      }
      res.end();
      return true;
    };
    assert.equal((await h.request("tools/call")).content[0].text, "分片");
  });
});

test("MCP SSE keeps the same finite message protection", async t => {
  const h = await session(t);
  h.state.reply = (message, _result, res) => {
    if (message.method !== "tools/call") return false;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message.method, "x".repeat(LIMIT)) })}\n\n`);
    return true;
  };
  await assert.rejects(h.request("tools/call"), /MCP SSE event exceeds 16777216 bytes/);
});
