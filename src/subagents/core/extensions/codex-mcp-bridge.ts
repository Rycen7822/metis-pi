/** Managed-child MCP proxy: bootstrap, tool policy, registration and readiness.
 * Credentials arrive only over the daemon's private pipe; connections stay in memory. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readSync, closeSync, writeSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { McpConnection, CancelledError, MAX_RESULT_TEXT, MAX_SCHEMA_BYTES,
  type ServerCfg, type ToolMeta, type HeaderPlanEntry } from "./mcp/connection.ts";
import { StdioConnection } from "./mcp/stdio.ts";
import { HttpConnection } from "./mcp/http.ts";

interface Bootstrap {
  v: number;
  agent: { id: string; access: string; generation: number };
  source: { codex_home: string; mode: string };
  mcp: { servers: ServerCfg[] };
}

const MAX_PAYLOAD = 8 * 1024 * 1024;
interface ReceiptServer { name: string; status: "ready" | "failed" | "lazy"; required: boolean; error?: string }

function writeReceipt(fdEnv: string | undefined, payload: Record<string, unknown>): void {
  if (!fdEnv || !/^\d+$/.test(fdEnv)) return;
  const fd = parseInt(fdEnv, 10);
  try {
    writeSync(fd, JSON.stringify(payload) + "\n");
  } catch { /* parent went away; nothing sensible to do */ }
  try { closeSync(fd); } catch { /* already closed */ }
}

function readBootstrap(): { payload?: Bootstrap; error?: string } {
  const g = globalThis as Record<string, unknown>;
  if (g.__subagentPiBridgeBootstrap) return g.__subagentPiBridgeBootstrap as { payload?: Bootstrap; error?: string };
  let result: { payload?: Bootstrap; error?: string };
  const raw = process.env.PI_AGENTS_BOOTSTRAP_FD;
  if (!raw || !/^\d+$/.test(raw)) {
    result = { error: "bootstrap channel missing" };
  } else {
    const fd = parseInt(raw, 10);
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      const buf = Buffer.alloc(65536);
      for (;;) {  // read to EOF; the parent writes asynchronously, so this blocks safely
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (total > MAX_PAYLOAD) throw new Error("bootstrap payload exceeds limit");
        chunks.push(Buffer.from(buf.subarray(0, n)));
      }
      closeSync(fd);
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Bootstrap;
      if (parsed?.v !== 1 || !Array.isArray(parsed?.mcp?.servers)) throw new Error("bootstrap payload malformed");
      result = { payload: parsed };
    } catch (err) {
      try { closeSync(fd); } catch { /* already closed */ }
      result = { error: `bootstrap failed: ${((err as Error).message || "unknown error").slice(0, 200)}` };
    }
  }
  g.__subagentPiBridgeBootstrap = result; // reload-safe: never block on a consumed pipe twice
  delete process.env.PI_AGENTS_BOOTSTRAP_FD; // downstream children must not see the channel name
  return result;
}

export default async function (pi: ExtensionAPI) {
  const boot = readBootstrap();
  const connections = new Map<string, McpConnection>();
  const servers: ServerCfg[] = boot.payload?.mcp.servers ?? [];
  const access = boot.payload?.agent.access ?? "write";

  function toolVisible(cfg: ServerCfg, meta: ToolMeta): boolean {
    if (cfg.disabled_tools.includes(meta.name)) return false;
    // The parent's enabled_tools is a declaration, not child authorization: an
    // explicit allowlist can only SHRINK the surface (empty = nothing).
    if (cfg.allowed_tools !== null && !cfg.allowed_tools.includes(meta.name)) return false;
    // P1-B: in a read child only explicitly readOnly tools are visible at all.
    // readOnlyHint is a self-report affecting the managed tool surface only.
    return access !== "read" || meta.readOnly === true;
  }

  function needsConfirmation(cfg: ServerCfg, meta: ToolMeta): boolean {
    // The child rule always wins over parent-side auto: a read child confirms
    // everything. Legacy payloads can also require confirm_all in a write child.
    return access === "read" || cfg.confirm_all === true ||
      (cfg.tool_approval[meta.name] ?? cfg.approval_default) !== "auto";
  }

  /** A tool with an invalid x-mcp-header annotation cannot be called: the plan is
   * what mirrors declared arguments into headers, so guessing would send a
   * different request than the schema declares. */
  function callableHeaderPlan(serverName: string, toolName: string, meta: ToolMeta): HeaderPlanEntry[] | undefined {
    if (!meta.headerPlan.ok) {
      throw new Error(`Tool ${serverName}.${toolName} declares an invalid x-mcp-header annotation (${meta.headerPlan.reason}) and is not callable`);
    }
    return meta.headerPlan.entries;
  }

  async function ensureConnection(cfg: ServerCfg): Promise<McpConnection> {
    const existing = connections.get(cfg.name);
    if (existing?.reusable) return existing;
    existing?.close();
    // Readiness initialization and tool execution are serial. Keep even an
    // initializing connection here so shutdown can close its pending requests.
    const conn = cfg.transport === "http" ? new HttpConnection(cfg) : new StdioConnection(cfg);
    connections.set(cfg.name, conn);
    try {
      await conn.initialize();
      return conn;
    } catch (err) {
      connections.delete(cfg.name);
      conn.close();
      throw new Error(`server ${cfg.name} failed to initialize: ${(err as Error).message.slice(0, 300)}`);
    }
  }

  function closeAll(): void {
    for (const [, conn] of connections) conn.close();
    connections.clear();
  }
  pi.on("session_shutdown", () => closeAll());

  function describeResult(result: unknown, configuredBudget?: number): string {
    const r = result as { content?: { type: string; text?: string }[]; structuredContent?: unknown };
    const parts: string[] = [];
    let unsupported = 0;
    for (const item of r?.content ?? []) {
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else unsupported += 1;
    }
    let text = parts.join("\n");
    let duplicatesStructured = false;
    if (parts.length === 1 && r?.structuredContent !== undefined) {
      try { duplicatesStructured = isDeepStrictEqual(JSON.parse(parts[0]), r.structuredContent); }
      catch { /* Plain text is independent content. */ }
    }
    if (r?.structuredContent !== undefined && !duplicatesStructured) {
      text += (text ? "\n" : "") + "structuredContent: " + JSON.stringify(r.structuredContent);
    }
    if (unsupported > 0) text += `\n[${unsupported} content item(s) of unsupported non-text type omitted; nothing was written to disk]`;
    const budget = configuredBudget && configuredBudget > 0 ? Math.min(configuredBudget, MAX_RESULT_TEXT) : MAX_RESULT_TEXT;
    if (Buffer.byteLength(text, "utf8") > budget) {
      // Streaming decode omits an incomplete final codepoint; retain a leading BOM.
      text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.from(text, "utf8").subarray(0, budget), { stream: true });
      text += configuredBudget ? "\n[output truncated to the configured output_token_limit budget]" : "\n[output truncated]";
    }
    return text;
  }

  function report(details: Record<string, unknown>) {
    return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
  }

  const parameters = Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("describe"), Type.Literal("call")]),
    server: Type.Optional(Type.String({ description: "Server name. list: optional (catalog one server); describe/call: required" })),
    tool: Type.Optional(Type.String({ description: "Tool name (describe/call)" })),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments object (call)" })),
  });

  async function execute(
    _id: string,
    params: { action: "list" | "describe" | "call"; server?: string; tool?: string; args?: Record<string, unknown> },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: { ui: { confirm: (title: string, message: string) => Promise<boolean> } },
  ) {
    if (boot.error) {
      throw new Error(`Inherited MCP is unavailable in this child: ${boot.error}`);
    }
    if (params.action === "list" && !params.server) {
      // level 1: cold start connects nothing
      const entries = servers.map((cfg) => ({
        server: cfg.name,
        transport: cfg.transport,
        required: cfg.required,
        policy: {
          allowed_tools: cfg.allowed_tools,
          disabled_tools: cfg.disabled_tools,
          approval_default: cfg.approval_default,
        },
      }));
      return report({ servers: entries });
    }
    const serverName = params.server;
    if (!serverName) throw new Error("action=describe|call requires server and tool");
    const cfg = servers.find((s) => s.name === serverName);
    if (!cfg) throw new Error(`Unknown server ${serverName}; use action=list`);
    if (params.action === "list") {
      // level 2: connect THIS server on demand; visibility rules apply here, not just at call time
      const conn = await ensureConnection(cfg);
      const { tools, truncated: catalogTruncated } = await conn.ensureTools(signal);
      // An invalid x-mcp-header annotation excludes just that tool; the server and
      // its other tools stay usable.
      const visible = tools.filter((t) => toolVisible(cfg, t) && t.headerPlan.ok);
      const entries = visible.map((t) => ({ name: t.name, description: t.description ?? "", read_only: t.readOnly }));
      let truncated = catalogTruncated || visible.length !== tools.length;
      let size = JSON.stringify({ server: serverName, tools: entries, truncated }).length;
      while (size > MAX_RESULT_TEXT && entries.length) {
        // Account once per removed entry instead of serializing the whole catalog again.
        size -= JSON.stringify(entries.pop()).length + (entries.length ? 1 : 0) + (truncated ? 0 : 1);
        truncated = true;
      }
      return report({ server: serverName, transport: cfg.transport, tools: entries, truncated });
    }
    const toolName = params.tool;
    if (!toolName) throw new Error("action=describe|call requires server and tool");
    if (cfg.disabled_tools.includes(toolName)) {
      throw new Error(`Tool ${serverName}.${toolName} is excluded by the inherited server policy`);
    }
    const conn = await ensureConnection(cfg);
    let { tools } = await conn.ensureTools(signal);
    let toolMeta = tools.find((t) => t.name === toolName);
    if (!toolMeta) {
      ({ tools } = await conn.ensureTools(signal)); // cache may be stale after list_changed
      toolMeta = tools.find((t) => t.name === toolName);
      if (!toolMeta) throw new Error(`Tool ${toolName} is not offered by ${serverName}; use action=list with server=${serverName} to discover tools`);
    }
    if (params.action === "describe") {
      if (!toolVisible(cfg, toolMeta)) {
        throw new Error(`Tool ${serverName}.${toolName} is not exposed to this child by the inherited policy`);
      }
      if (!toolMeta.inputSchema) {
        throw new Error(
          `Tool ${serverName}.${toolName} has no usable inputSchema (missing or larger than ${MAX_SCHEMA_BYTES} bytes)`,
        );
      }
      callableHeaderPlan(serverName, toolName, toolMeta);
      return report({
        server: serverName,
        tool: toolMeta.name,
        description: toolMeta.description,
        inputSchema: toolMeta.inputSchema,
      });
    }
    // action === "call": same effective policy, checked against current metadata right before execution
    if (!toolVisible(cfg, toolMeta)) {
      throw new Error(
        `Tool ${serverName}.${toolName} is not available to this managed child (access=${access}; only explicitly read-only tools are exposed)`,
      );
    }
    const headerPlan = callableHeaderPlan(serverName, toolName, toolMeta);
    if (needsConfirmation(cfg, toolMeta)) {
      const argsPreview = JSON.stringify(params.args ?? {}).slice(0, 500);
      const ok = await ctx.ui.confirm(
        "MCP tool call",
        `Allow inherited MCP call ${serverName}.${toolName}? args: ${argsPreview}`,
      );
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "Approval denied; the MCP tool was not called" }],
          details: { confirmed: false },
        }; // denial is not an error
      }
    }
    if (signal?.aborted) throw new CancelledError(false);
    try {
      const result = (await conn.callTool(toolName, params.args ?? {}, cfg.tool_timeout_sec, signal, headerPlan)) as
        { isError?: boolean } | undefined;
      const text = describeResult(result, cfg.tool_output_limits?.[toolName]);
      if (result?.isError) throw new Error(`MCP tool reported failure: ${text.slice(0, 1000)}`); // Pi sets isError on throw
      return { content: [{ type: "text" as const, text }], details: { server: serverName, tool: toolName } };
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "CancelledError")
        throw new CancelledError(true);
      // no automatic retry: a tools/call may have had side effects
      throw new Error(`MCP call ${serverName}.${toolName} failed: ${(err as Error).message.slice(0, 500)}`);
    }
  }

  // P1-B: one proxy tool fronts every inherited server, so all calls through it
  // serialize conservatively. Enforced twice: here with an in-memory promise
  // chain (no persistent scheduler), and via Pi's executionMode below.
  let executeChain: Promise<unknown> = Promise.resolve();
  const serializedExecute: typeof execute = (...args) => {
    const run = executeChain.then(() => execute(...args));
    executeChain = run.then(() => undefined, () => undefined);  // a cancelled first call never poisons the chain
    return run;
  };

  pi.registerTool({
    name: "codex_mcp",
    executionMode: "sequential",
    label: "Codex MCP bridge",
    description:
      "Discover and call tools on Codex MCP servers inherited into this managed child. " +
      "Discovery: action=list (no server) shows configured servers and policy without " +
      "connecting; action=list with server=<name> connects that one server and lists its " +
      "visible tool names and short descriptions. action=describe with server+tool returns " +
      "a tool's full inputSchema; action=call invokes server+tool with an args object. " +
      "Connections live in memory for this worker's lifetime; nothing is cached on disk.",
    parameters,
    execute: serializedExecute,
  });

  // Readiness receipt: required servers initialize eagerly so the daemon knows
  // dependencies work BEFORE any task is sent; optional servers stay lazy.
  const receiptFd = process.env.PI_AGENTS_BRIDGE_RECEIPT_FD;
  delete process.env.PI_AGENTS_BRIDGE_RECEIPT_FD;
  const agent = boot.payload?.agent;
  const receiptServers: ReceiptServer[] = [];
  let failedRequired = false;
  for (const cfg of servers) {
    if (!cfg.required) {
      receiptServers.push({ name: cfg.name, status: "lazy", required: false });
      continue;
    }
    try {
      const conn = await ensureConnection(cfg);
      await conn.ensureTools();
      receiptServers.push({ name: cfg.name, status: "ready", required: true });
    } catch (err) {
      receiptServers.push({ name: cfg.name, status: "failed", required: true, error: (err as Error).message.slice(0, 200) });
      failedRequired = true;
    }
  }
  if (failedRequired) closeAll();
  writeReceipt(receiptFd, {
    kind: "subagent-pi-bridge-receipt",
    v: 1,
    agent: agent?.id ?? null,
    generation: agent?.generation ?? null,
    state: failedRequired ? "failed" : "ready",
    servers: receiptServers,
  });
  const readyCount = receiptServers.filter((s) => s.status !== "failed").length;
  if (boot.error) {
    process.stderr.write(`subagent-pi-bridge ready servers=0 error=${boot.error.slice(0, 200)}\n`);
  } else {
    process.stderr.write(`subagent-pi-bridge ready servers=${readyCount}\n`);
  }
}
