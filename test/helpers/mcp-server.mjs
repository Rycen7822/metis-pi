import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const tools = type => [{ name: "echo", description: "Return a value, optionally delay or fail", annotations: { readOnlyHint: true },
  inputSchema: { type: "object", properties: { value: { type }, delayMs: { type: "number" }, domainError: { type: "boolean" } }, required: ["value"] },
  outputSchema: { type: "object", properties: { value: { type }, calls: { type: "number" } }, required: ["value", "calls"] } }];
const resources = [{ uri: "data://plain", name: "plain", mimeType: "text/plain" }, { uri: "ui://panel", name: "ui", mimeType: "text/html;profile=mcp-app" }];
async function rpc(message, state) {
  const { method, params = {} } = message;
  if (method === "initialize") { state.starts++; state.record?.("initialize"); await delay(state.initializeDelay ?? 0); return { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: "fixture", version: "1" } }; }
  if (method === "tools/list") { const result = tools(state.schema ? JSON.parse(readFileSync(state.schema, "utf8")).type : state.type); await state.onList?.(); return { tools: result }; }
  if (method === "tools/call") {
    state.calls++; state.record?.(`call:${JSON.stringify(params.arguments)}`);
    await delay(params.arguments.delayMs ?? 0);
    return { content: [{ type: "text", text: String(params.arguments.value) }, { type: "image", data: image, mimeType: "image/png" },
      { type: "resource", resource: { uri: "ui://panel", text: "UI_SECRET", mimeType: "text/html;profile=mcp-app" } }],
      structuredContent: { value: params.arguments.value, calls: state.calls }, isError: params.arguments.domainError === true };
  }
  if (method === "resources/list") return { resources };
  if (method === "resources/templates/list") return { resourceTemplates: [{ uriTemplate: "data://{name}", name: "plain" }, { uriTemplate: "ui://{name}", name: "ui" }] };
  if (method === "resources/read") return { contents: [{ uri: params.uri, text: params.uri.startsWith("ui://") ? "UI_SECRET" : "resource-body", mimeType: "text/plain" }] };
  if (method === "ping") return {};
  throw new Error(`Unsupported fixture method: ${method}`);
}
export async function startHttp({ oauth = false } = {}) {
  const state = { type: "integer", starts: 0, calls: 0, refreshes: 0, serial: 1, refreshDelay: 0, expire: false, fail: false };
  const streams = new Set();
  let base;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base), chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const json = (value, status = 200, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: base + "/mcp", authorization_servers: [base], scopes_supported: ["tools"] });
      if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) return json({ issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token",
        registration_endpoint: base + "/register", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url.pathname === "/register") return json({ ...JSON.parse(text), client_id: "fixture-client" }, 201);
      if (url.pathname === "/authorize") {
        const callback = new URL(url.searchParams.get("redirect_uri")); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { Location: callback.href }); return res.end();
      }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(text);
        if (params.get("grant_type") === "refresh_token") {
          state.refreshes++; state.onRefresh?.(); await delay(state.refreshDelay);
          if (params.get("refresh_token") !== `refresh-${state.serial}`) return json({ error: "invalid_grant" }, 400);
          state.serial++;
        }
        return json({ access_token: `access-${state.serial}`, refresh_token: `refresh-${state.serial}`, token_type: "Bearer", expires_in: 3600, scope: "tools" });
      }
      if (oauth && req.headers.authorization !== `Bearer access-${state.serial}`)
        return json({}, 401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      if (req.method === "DELETE") { state.deleted = (state.deleted ?? 0) + 1; res.writeHead(204); return res.end(); }
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": ready\n\n"); streams.add(res); res.on("close", () => streams.delete(res)); return;
      }
      const message = JSON.parse(text);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      if (message.method === "tools/call" && state.expire) { state.expire = false; return json({}, 404); }
      const result = await rpc(message, state);
      if (message.method === "tools/call" && state.fail) return json({ error: "after-side-effect" }, 502);
      return json({ jsonrpc: "2.0", id: message.id, result }, 200,
        message.method === "initialize" ? { "Mcp-Session-Id": `fixture-${state.starts}` } : {});
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${server.address().port}`;
  return { url: base + "/mcp", state,
    notify: () => { for (const stream of streams) stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'); },
    close: async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[2] === "stdio" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = process.argv[3], state = { type: "integer", starts: 0, calls: 0, schema: process.argv[4], initializeDelay: Number(process.argv[5] ?? 0), record: line => appendFileSync(log, line + "\n") };
  state.record(`start:${process.pid}`); process.on("exit", () => state.record(`closed:${process.pid}`));
  const lines = createInterface({ input: process.stdin }); lines.on("close", () => { if (!state.initializeDelay) process.exit(); });
  lines.on("line", async line => { const message = JSON.parse(line); if (message.id === undefined) return;
    try { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: await rpc(message, state) }) + "\n"); }
    catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } }) + "\n"); }
  });
}
