export const MAX_RESULT_TEXT = 256 * 1024;
export const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PAGES = 20;
const MAX_TOOLS = 512;

export interface ServerCfg {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  bearer_token?: string | null;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  required: boolean;
  protocol_mode?: "auto" | "legacy_2025_06_18" | "modern_2026_07_28";
  tool_output_limits?: Record<string, number>;
  allowed_tools: string[] | null;
  disabled_tools: string[];
  approval_default: "auto" | "confirm";
  tool_approval: Record<string, "auto" | "confirm">;
  // Read children confirm every call; the parent may only ever tighten this.
  confirm_all?: boolean;
}
export interface ToolMeta {
  name: string;
  description?: string;
  readOnly: boolean;
  inputSchema?: unknown;
  headerPlan: HeaderPlan;
}
export interface ToolCatalog { tools: ToolMeta[]; truncated: boolean }
// x-mcp-header (MCP 2026-07-28): a tool may declare that a plain
// string/integer/boolean argument is mirrored into an HTTP header. The plan is
// computed once from the inputSchema at discovery and kept in memory only.
export type HeaderPlanEntry = { path: string[]; header: string; type: "string" | "integer" | "boolean" };
type HeaderPlan = { ok: true; entries: HeaderPlanEntry[] } | { ok: false; reason: string };
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_DYNAMIC_KEYS = ["items", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "$ref", "dependentSchemas", "patternProperties"];
const HEADER_MAX_DEPTH = 8;
const HEADER_MAX_NODES = 256;
function parseHeaderPlan(schema: unknown): HeaderPlan {
  const entries: HeaderPlanEntry[] = [];
  const seen = new Set<string>();  // header names, lower-cased for case-insensitive uniqueness
  let nodes = 0;
  // Reachable annotations are found by walking ONLY through properties chains.
  const legalWalk = (node: unknown, path: string[], depth: number): string | null => {
    if (++nodes > HEADER_MAX_NODES) return `inputSchema exceeds the x-mcp-header walker limit (${HEADER_MAX_NODES} nodes)`;
    if (depth > HEADER_MAX_DEPTH) return `property '${path.join(".")}' exceeds the maximum nesting depth (${HEADER_MAX_DEPTH})`;
    if (typeof node !== "object" || node === null) return null;
    const properties = (node as { properties?: unknown }).properties;
    if (properties === undefined) return null;
    if (typeof properties !== "object" || properties === null) return `property '${path.join(".")}': properties is not an object`;
    for (const [param, def] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof def !== "object" || def === null) continue;
      const here = [...path, param];
      if ("x-mcp-header" in def) {
        const why = (reason: string): string => `property '${here.join(".")}': ${reason}`;
        const annotation = (def as Record<string, unknown>)["x-mcp-header"];
        if (typeof annotation !== "string" || !annotation) return why("x-mcp-header annotation must be a non-empty string");
        if (!HEADER_TOKEN.test(annotation)) return why("x-mcp-header annotation is not a valid HTTP token");
        if (seen.has(annotation.toLowerCase())) return why(`x-mcp-header '${annotation}' duplicates an earlier header (case-insensitive)`);
        const type = (def as Record<string, unknown>).type;
        if (type !== "string" && type !== "integer" && type !== "boolean") return why("x-mcp-header requires type string, integer or boolean");
        seen.add(annotation.toLowerCase());
        entries.push({ path: here, header: annotation, type });
      }
      // a properties path must not pass THROUGH a dynamic ancestor ($ref,
      // items, oneOf, ...); annotations beneath one are caught by the count check
      if (HEADER_DYNAMIC_KEYS.some((k) => k in (def as Record<string, unknown>))) continue;
      const nested = legalWalk(def, here, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  // The full scan counts EVERY annotation in the schema. More annotations than
  // the properties-chain walk collected means one sits under a dynamic position
  // (items/oneOf/anyOf/allOf/not/if/then/else/$ref/dependentSchemas/patternProperties).
  const countAnnotations = (root: unknown): number => {
    let count = 0;
    const stack = [root];
    while (stack.length > 0) {
      if (++nodes > HEADER_MAX_NODES * 2) return Number.POSITIVE_INFINITY;  // budget shared with the legal walk
      const cur = stack.pop();
      if (Array.isArray(cur)) { stack.push(...cur); continue; }
      if (typeof cur !== "object" || cur === null) continue;
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        if (k === "x-mcp-header") count += 1;
        else stack.push(v);
      }
    }
    return count;
  };
  if (typeof schema !== "object" || schema === null) return { ok: true, entries };
  const legalError = legalWalk(schema, [], 0);
  if (legalError) return { ok: false, reason: legalError };
  if (countAnnotations(schema) > entries.length) {
    return { ok: false, reason: "x-mcp-header annotation under an unsupported dynamic path (only plain properties chains are supported)" };
  }
  return { ok: true, entries };
}
// MCP 2026-07-28 header value encoding: plain visible ASCII (plus interior
// SP/HTAB, no leading/trailing whitespace) is sent as-is; anything else —
// non-ASCII, control characters, edge whitespace, or a value shaped like the
// Base64 sentinel — travels as `=?base64?<Base64 UTF-8>?=`.
// This is also the CRLF-injection defense: unsafe bytes never hit the wire raw.
export function encodeMcpHeaderValue(value: string): string {
  const plain = value.length > 0 && !/[^\x09\x20-\x7e]|^[ \t]|[ \t]$/.test(value);
  // ANY string shaped like the sentinel is re-encoded, so a literal value can
  // never be mistaken for an encoded one on the receiving side.
  if (plain && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export class CancelledError extends Error {
  constructor(public outcomeUnknown: boolean) {
    super(outcomeUnknown
      ? "call cancelled in flight; server outcome is unknown and the call was not retried"
      : "call cancelled before it was sent");
    this.name = "CancelledError";
  }
}


export interface JsonRpcResponse { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }


function toToolMeta(raw: unknown, mirrorHeaders: boolean): ToolMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as { name?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown }; inputSchema?: unknown };
  if (typeof t.name !== "string" || !t.name) return null;
  let schema: unknown;
  if (typeof t.inputSchema === "object" && t.inputSchema !== null) {
    const encoded = JSON.stringify(t.inputSchema);
    if (encoded.length <= MAX_SCHEMA_BYTES) schema = t.inputSchema;
  }
  return {
    name: t.name,
    description: typeof t.description === "string" ? t.description.slice(0, 200) : undefined,
    readOnly: t.annotations?.readOnlyHint === true,
    inputSchema: schema,
    // stdio never parses or enforces x-mcp-header: an HTTP-only annotation must
    // not take a stdio tool out of the catalog.
    headerPlan: mirrorHeaders ? parseHeaderPlan(schema) : { ok: true, entries: [] },
  };
}

export abstract class McpConnection {
  constructor(protected cfg: ServerCfg) {}
  private toolsCache: ToolCatalog | null = null;
  protected mirrorHeaders: boolean = false;  // HTTP-only: stdio tools ignore x-mcp-header entirely
  private catalogEpoch = 0; // bump on list_changed so an in-flight crawl never repopulates an invalidated cache
  protected invalidateCatalog(): void {
    this.toolsCache = null;
    this.catalogEpoch += 1;
  }
  /** MCP 2026-07-28: every request self-describes via _meta (no handshake). */
  protected withMeta(params: unknown): unknown {
    const base = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    return { ...base, _meta: { ...((base._meta ?? {}) as Record<string, unknown>), ...MODERN_META } };
  }
  /** False when the next explicit operation must initialize a fresh connection. */
  abstract get reusable(): boolean;
  abstract request(method: string, params: unknown, timeoutSec: number, opts?: { notification?: boolean; signal?: AbortSignal }): Promise<unknown>;
  abstract initialize(): Promise<void>;
  callTool(name: string, args: unknown, timeoutSec: number, signal?: AbortSignal,
           _headerPlan?: HeaderPlanEntry[]): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} }, timeoutSec, { signal });
  }
  abstract close(): void;
  async ensureTools(signal?: AbortSignal): Promise<ToolCatalog> {
    // Keep tools and completeness together across cache hits and invalidation.
    if (this.toolsCache) return this.toolsCache;
    const epochAtStart = this.catalogEpoch;
    const collected: ToolMeta[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    const seenCursors = new Set<string>();
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, this.cfg.startup_timeout_sec, { signal }) as
        { tools?: unknown[]; nextCursor?: unknown };
      const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (next) {
        if (seenCursors.has(next)) { truncated = true; break; } // server cursor loop guard
        seenCursors.add(next);
      }
      for (const tool of result?.tools ?? []) {
        if (collected.length >= MAX_TOOLS) { truncated = true; break; }
        const meta = toToolMeta(tool, this.mirrorHeaders);
        if (meta) collected.push(meta);
      }
      cursor = next;
      pages += 1;
    } while (cursor && pages < MAX_PAGES && collected.length < MAX_TOOLS);
    if (cursor && (pages >= MAX_PAGES || collected.length >= MAX_TOOLS)) truncated = true;
    const catalog = { tools: collected, truncated };
    if (this.catalogEpoch === epochAtStart) this.toolsCache = catalog;  // a list_changed that arrived mid-crawl must win
    return catalog;
  }
}


// MCP protocol eras. Legacy (2025-06-18): initialize handshake + Mcp-Session-Id.
// Modern (2026-07-28): stateless — no handshake, every request self-describes via
// _meta and the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers.
export const MODERN_VERSION = "2026-07-28";
// MCP 2026 recognized modern protocol errors: HeaderMismatch,
// MissingRequiredClientCapability, UnsupportedProtocolVersion.
const MODERN_ERROR_CODES = new Set([-32020, -32021, -32022]);

/** Single modern-error classifier shared by the HTTP probe and the stdio Auto
 * lifecycle: a recognized modern code keeps the modern era (no initialize);
 * anything else is a legacy-style error. -32022 additionally requires a common
 * supported version, reported as a hard incompatibility (never a fallback). */
export function classifyProtocolError(err: unknown): "modern" | "legacy" {
  const code = err instanceof RpcError ? err.code : err instanceof HttpRpcError ? err.jsonRpcCode : null;
  if (code === null || !MODERN_ERROR_CODES.has(code)) return "legacy";
  if (code !== -32022) return "modern";
  const data = err instanceof RpcError ? err.data : err instanceof HttpRpcError ? err.jsonRpcData : null;
  const supported = Array.isArray((data as { supported?: unknown } | null)?.supported)
    ? (data as { supported: unknown[] }).supported.map(String) : [];
  if (!supported.includes(MODERN_VERSION)) {
    throw new Error(`server only supports modern protocol versions [${supported.join(", ") || "none listed"}]; ` +
      `this bridge speaks ${MODERN_VERSION} — no common modern version, refusing to guess`);
  }
  return "modern";
}

/** A successful server/discover must be a real 2026 DiscoverResult naming a
 * common modern version; anything else is a protocol error, never a fallback. */
export function assertDiscoverResult(result: unknown): void {
  if (typeof result !== "object" || result === null) throw new Error("malformed DiscoverResult: result is not an object");
  const r = result as { resultType?: unknown; supportedVersions?: unknown };
  if (typeof r.resultType !== "string" || !r.resultType) throw new Error("malformed DiscoverResult: missing resultType");
  if (!Array.isArray(r.supportedVersions)) throw new Error("malformed DiscoverResult: supportedVersions is not an array");
  if (!r.supportedVersions.map(String).includes(MODERN_VERSION)) {
    throw new Error(`DiscoverResult supportedVersions [${r.supportedVersions.map(String).join(", ") || "none listed"}] ` +
      `has no common version with this bridge (${MODERN_VERSION})`);
  }
}
export const CLIENT_INFO = { name: "subagent-pi-bridge", version: "0.5.0" };
export const LEGACY_INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: CLIENT_INFO };
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
  "io.modelcontextprotocol/clientCapabilities": {},
};
export class StaleSessionError extends Error { constructor(m: string) { super(m); this.name = "StaleSessionError"; } }
/** In-band JSON-RPC error (HTTP 200 body or SSE frame). */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(`server error ${code}: ${message.slice(0, 300)}`);
    this.name = "RpcError";
  }
}
export function rpcResult(value: unknown, id: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON-RPC response");
  const msg = value as JsonRpcResponse;
  const hasResult = Object.hasOwn(msg, "result");
  const hasError = Object.hasOwn(msg, "error");
  if (msg.jsonrpc !== "2.0" || msg.id !== id || hasResult === hasError) {
    throw new Error("invalid JSON-RPC response: version, id or result/error mismatch");
  }
  if (hasError) {
    if (!msg.error || typeof msg.error.code !== "number" || typeof msg.error.message !== "string") {
      throw new Error("invalid JSON-RPC response: malformed error");
    }
    throw new RpcError(msg.error.code, msg.error.message, msg.error.data);
  }
  return msg.result;
}
/** HTTP-level failure carrying the parsed JSON-RPC error body, when one existed. */
export class HttpRpcError extends Error {
  constructor(public status: number, public jsonRpcCode: number | null,
              public jsonRpcData: unknown, url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpRpcError";
  }
}
