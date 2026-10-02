/** Streamable HTTP: one deadline across redirects, response body and parsing. */
import { McpConnection, CancelledError, MODERN_VERSION, LEGACY_INIT, MAX_RESULT_TEXT,
  encodeMcpHeaderValue, rpcResult, assertDiscoverResult, classifyProtocolError, RpcError, HttpRpcError, StaleSessionError,
  type JsonRpcResponse, type HeaderPlanEntry } from "./connection.ts";

const MAX_ERROR_BODY = 64 * 1024;  // non-2xx JSON-RPC error bodies, era classification only
const ABORT_DEADLINE = Symbol("deadline");
const MAX_REDIRECTS = 3;
const ABORT_USER = Symbol("user");
const ABORT_CLOSED = Symbol("closed");

function redactUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

export class HttpConnection extends McpConnection {
  private sessionId: string | null = null;
  private nextId = 1;
  private closed = false;
  private active = new Set<AbortController>();  // every in-flight exchange, so close() can end them all
  private mode: "undecided" | "legacy" | "modern" = "undecided";
  private stale = false;  // legacy session expired (HTTP 404); re-initialize on the next explicit operation
  private negotiatedVersion: string | null = null;

  protected mirrorHeaders = true;
  get reusable(): boolean { return !this.closed && !this.stale; }

  private headers(method?: string, toolName?: string,
                  paramHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.cfg.bearer_token) headers.authorization = `Bearer ${this.cfg.bearer_token}`;
    // NOTE: no early return for DELETE — the legacy session id must ride along.
    if (this.mode !== "legacy") {
      // 2026-07-28 (and the auto probe): every request is self-describing; the
      // headers let gateways route and authorize without parsing JSON bodies.
      headers["mcp-protocol-version"] = MODERN_VERSION;
      if (method) headers["mcp-method"] = method;
      if (method === "tools/call" && toolName) headers["mcp-name"] = encodeMcpHeaderValue(toolName);
    } else {
      if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;  // negotiated at initialize
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    }
    if (paramHeaders) Object.assign(headers, paramHeaders);  // Mcp-Param-* from the tool's x-mcp-header plan
    return headers;
  }

  private async *readBody(response: Response, limit: number, empty: string, oversized: string) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error(empty);
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new Error(oversized);
        yield value;
      }
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }

  private async readBoundedJson(response: Response, limit: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of this.readBody(response, limit, "empty response body", "response body exceeds limit")) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private async discard(response: Response): Promise<void> {
    try { await response.body?.cancel(); } catch { /* already consumed or closed */ }
  }

  private async parseSse(response: Response, id: number): Promise<unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    for await (const value of this.readBody(response, MAX_RESULT_TEXT,
      "empty event-stream response", "event-stream exceeded limit")) {
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5);
          dataLines.push(data.startsWith(" ") ? data.slice(1) : data);
        } else if (!line && dataLines.length) {
          const data = dataLines.join("\n");
          dataLines = [];
          if (data === "[DONE]") continue;
          let msg: JsonRpcResponse;
          try { msg = JSON.parse(data) as JsonRpcResponse; }
          catch { continue; }
          if (msg && typeof msg === "object" && msg.id === id) return rpcResult(msg, id);
        }
      }
    }
    throw new Error("event-stream closed before the JSON-RPC response arrived");
  }

  async request(method: string, params: unknown, timeoutSec: number,
                opts: { notification?: boolean; signal?: AbortSignal; toolName?: string; paramHeaders?: Record<string, string> } = {}): Promise<unknown> {
    // One exchange, one AbortController: the deadline, caller cancellation and
    // connection close all cover send/headers/body/parse until settlement, so a
    // hung body still hits the deadline. No exchange is ever retried here.
    if (this.closed) throw new Error(`connection ${this.cfg.name} is closed`);
    if (opts.signal?.aborted) throw new CancelledError(false);
    const id = opts.notification ? null : this.nextId++;
    const sent = id !== null;
    const wireParams = this.mode === "legacy" ? params : this.withMeta(params);
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(ABORT_DEADLINE), timeoutSec * 1000);
    const onOuterAbort = () => controller.abort(ABORT_USER);
    if (opts.signal) {
      if (opts.signal.aborted) { clearTimeout(timer); this.active.delete(controller); throw new CancelledError(false); }
      opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    try {
      const body = id === null ? { jsonrpc: "2.0", method, params: wireParams } : { jsonrpc: "2.0", id, method, params: wireParams };
      const response = await this.send(this.cfg.url as string, {
        method: "POST",
        headers: this.headers(method, opts.toolName, opts.paramHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 2025-06-18 session lifecycle: a 404 on a session-scoped request means
        // the session expired; the client must re-initialize. The sent request
        // is never replayed automatically — its outcome stays unknown.
        if (response.status === 404 && this.mode === "legacy" && this.sessionId && method !== "initialize") {
          this.stale = true;
          await this.discard(response);
          throw new StaleSessionError(`MCP session expired (HTTP 404)${sent ? "; the sent request's outcome is unknown" : ""}; the next explicit operation re-initializes`);
        }
        throw await this.classifyHttpError(response);
      }
      if (this.mode === "legacy") {
        const session = response.headers.get("mcp-session-id");
        if (session) this.sessionId = session;
      }
      if (id === null) { await this.discard(response); return null; } // notification accepted; nothing to wait for
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) return await this.parseSse(response, id);
      return rpcResult(await this.readBoundedJson(response, MAX_RESULT_TEXT), id);
    } catch (err) {
      // classify by WHO aborted; sent requests keep an outcome-unknown wording
      if (opts.signal?.aborted) {
        if (err instanceof CancelledError) throw err;
        throw new CancelledError(sent);
      }
      if (err === ABORT_DEADLINE) throw new Error(`${method} exchange timed out after ${timeoutSec}s${sent ? "; server outcome is unknown" : ""}`);
      if (err === ABORT_CLOSED) throw new Error(`${method} exchange ended because the connection was closed${sent ? "; server outcome is unknown" : ""}`);
      if (err === ABORT_USER) throw new CancelledError(sent);
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
      this.active.delete(controller);
    }
  }

  async initialize(): Promise<void> {
    const requested = this.cfg.protocol_mode ?? "auto";
    // Only side-effect-free discovery may select an era; never retry tools/call.
    this.mode = requested === "legacy_2025_06_18" ? "legacy"
      : requested === "modern_2026_07_28" || await this.probeModern() ? "modern" : "legacy";
    if (this.mode === "modern") await this.request("tools/list", {}, this.cfg.startup_timeout_sec);
    else await this.legacyInitialize();
  }

  private async legacyInitialize(): Promise<void> {
    const result = await this.request("initialize", LEGACY_INIT, this.cfg.startup_timeout_sec) as { protocolVersion?: unknown } | undefined;
    // Negotiate: honor the server's returned version for all later requests.
    this.negotiatedVersion = typeof result?.protocolVersion === "string" && result.protocolVersion ? result.protocolVersion : LEGACY_INIT.protocolVersion;
    await this.request("notifications/initialized", {}, this.cfg.startup_timeout_sec, { notification: true });
  }

  private async probeModern(): Promise<boolean> {
    // Era detection happens ONLY on the side-effect-free server/discover,
    // classified by the bounded JSON-RPC error BODY (never message strings):
    // a recognized modern error (-32020/-32021/-32022) keeps modern — no
    // initialize is ever sent; an unrecognized or legacy-style 400, 404 or 405
    // proves legacy-only. Auth/rate-limit/5xx failures are errors, never
    // downgrade triggers, and a sent tools/call is never replayed either way.
    try {
      assertDiscoverResult(await this.request("server/discover", {}, this.cfg.startup_timeout_sec));
      return true;
    } catch (err) {
      if (err instanceof HttpRpcError) {
        if (err.status !== 400 && err.status !== 404 && err.status !== 405) throw err;
        return classifyProtocolError(err) === "modern";
      }
      if (err instanceof RpcError) {
        if (classifyProtocolError(err) === "modern") return true;  // in-band modern error on HTTP 200
        if (err.code === -32601) return false;  // legacy-style method-not-found
        throw err;
      }
      throw err;  // timeouts and user aborts are errors, never a downgrade trigger
    }
  }

  /** Manual redirect handling (SameOriginRedirect policy): no header or body
   * is ever transmitted to a redirect target before its origin is verified
   * against the ORIGINAL MCP origin. 301/302/303 become body-less GETs;
   * 307/308 preserve method, headers and body. Every hop shares the exchange's
   * single deadline (one AbortController) and the visited set blocks cycles. */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const originalOrigin = new URL(this.cfg.url as string).origin;
    let current = url;
    let hopInit = init;
    const visited = new Set<string>([current]);
    for (let hop = 0; ; hop++) {
      const response = await fetch(current, { ...hopInit, redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      try {
        const location = response.headers.get("location");
        if (!location) throw new Error(`HTTP ${response.status} redirect without Location from ${redactUrl(current)}`);
        const next = new URL(location, current);
        if (next.origin !== originalOrigin) {
          throw new Error(`refusing cross-origin redirect to ${redactUrl(next.toString())}; no headers or body were sent`);
        }
        if (visited.has(next.toString())) throw new Error(`redirect loop at ${redactUrl(next.toString())}`);
        visited.add(next.toString());
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
        if (response.status !== 307 && response.status !== 308) {
          const headers = { ...(hopInit.headers as Record<string, string>) };
          delete headers["content-type"];
          delete headers["content-length"];
          hopInit = { ...hopInit, method: "GET", body: undefined, headers };
        }
        current = next.toString();
      } finally {
        await this.discard(response);
      }
    }
  }

  private async classifyHttpError(response: Response): Promise<Error> {
    // The error body is read with a strict byte cap and used ONLY to classify
    // the protocol era and produce a precise diagnostic; it is never logged.
    const url = redactUrl(this.cfg.url ?? "");
    let body: unknown;
    try {
      body = await this.readBoundedJson(response, MAX_ERROR_BODY);
    } catch { /* not JSON, or over the cap */ }
    const rpc = (body && typeof body === "object" ? (body as { error?: unknown }).error : undefined) as
      { code?: unknown; message?: unknown; data?: unknown } | undefined;
    if (rpc && typeof rpc.code === "number") {
      return new HttpRpcError(response.status, rpc.code, rpc.data, url);
    }
    return new HttpRpcError(response.status, null, null, url);
  }

  async callTool(name: string, args: unknown, timeoutSec: number, signal?: AbortSignal,
                 headerPlan?: HeaderPlanEntry[]): Promise<unknown> {
    let paramHeaders: Record<string, string> | undefined;
    if (this.mode === "modern" && headerPlan && headerPlan.length > 0) {
      // Mirror only declared, plain-typed arguments, read by schema path; the
      // body keeps every argument unchanged and an absent argument produces no header.
      paramHeaders = {};
      for (const entry of headerPlan) {
        let node: unknown = args;
        let reachable = true;
        for (const seg of entry.path) {
          if (typeof node !== "object" || node === null) { reachable = false; break; }
          node = (node as Record<string, unknown>)[seg];
        }
        if (!reachable || node === undefined) continue;
        const bad = (why: string): Error =>
          new Error(`argument ${entry.path.join(".")} ${why}; refusing to mirror it as a header`);
        if (entry.type === "boolean" && typeof node !== "boolean") throw bad("is not a boolean");
        if (entry.type === "integer" && !(typeof node === "number" && Number.isSafeInteger(node))) throw bad("is not a safe integer");
        if (entry.type === "string" && typeof node !== "string") throw bad("is not a string");
        paramHeaders[`Mcp-Param-${entry.header}`] = encodeMcpHeaderValue(String(node));
      }
      if (Object.keys(paramHeaders).length === 0) paramHeaders = undefined;
    }
    return await this.request("tools/call", { name, arguments: args ?? {} }, timeoutSec, { signal, toolName: name, paramHeaders });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active) controller.abort(ABORT_CLOSED);
    this.active.clear();
    // Best-effort session termination per the 2025-06-18 spec (DELETE the session).
    // Fire-and-forget: the worker may be exiting, so an unconfirmed DELETE is a
    // documented boundary, never a retry path.
    if (this.mode === "legacy" && this.sessionId) {
      try {
        void fetch(this.cfg.url as string, {
          method: "DELETE", headers: this.headers(),
          redirect: "manual",  // session termination must never leak to another origin
          signal: AbortSignal.timeout(2000),
        }).then(r => { void r.body?.cancel(); }).catch(() => { });
      } catch { /* ignore */ }
    }
    this.sessionId = null;
  }
}

