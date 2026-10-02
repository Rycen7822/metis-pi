/** Newline JSON-RPC and ownership of an inherited MCP process tree. */
import { readFileSync, readdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { McpConnection, CancelledError, LEGACY_INIT, rpcResult, classifyProtocolError, assertDiscoverResult,
  type ServerCfg, type JsonRpcResponse } from "./connection.ts";

const MAX_STDIN_BUFFER = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
const SELF_BINARY = "subagent-pi";
const SELF_MODULE = "subagent_pi";

type ProcessIdentity = { pid: number; startTime: string };
function procStat(pid: number): { ppid: number; state: string; startTime: string } | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (!fields[19]) return null;
    return { state: fields[0], ppid: Number(fields[1]), startTime: fields[19] };
  } catch { return null; }
}
function descendantsOf(root: ProcessIdentity): ProcessIdentity[] {
  if (process.platform !== "linux" || procStat(root.pid)?.startTime !== root.startTime) return [];
  const children = new Map<number, ProcessIdentity[]>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const candidate = Number(name);
      const stat = procStat(candidate);
      if (!stat || stat.state === "Z") continue;
      const list = children.get(stat.ppid) ?? [];
      list.push({ pid: candidate, startTime: stat.startTime });
      children.set(stat.ppid, list);
    }
  } catch { return []; }
  const found: ProcessIdentity[] = [];
  const seen = new Set<number>([root.pid]);
  const queue = [root.pid];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return procStat(root.pid)?.startTime === root.startTime ? found : [];
}
function signalIfSame(proc: ProcessIdentity, signal: NodeJS.Signals): void {
  const current = procStat(proc.pid);
  if (current?.startTime !== proc.startTime || current.state === "Z") return;
  try { process.kill(proc.pid, signal); } catch { /* already gone or inaccessible */ }
}

export class StdioConnection extends McpConnection {
  private proc: ChildProcess | null = null;
  private procStartTime: string | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (error: Error | null, result?: unknown) => void>();
  private closed = false;
  private era: "legacy" | "modern";
  exitError: string | null = null;

  constructor(cfg: ServerCfg) {
    super(cfg);
    this.era = this.cfg.protocol_mode === "modern_2026_07_28" ? "modern" : "legacy";
  }

  get reusable(): boolean {
    return !this.closed && this.proc !== null && this.exitError === null;
  }

  private failPending(message: string): void {
    const err = new Error(message);
    for (const finish of this.pending.values()) finish(err);
  }

  private ensureProcess(): ChildProcess {
    if (this.closed) throw new Error("stdio connection is closed");
    if (this.proc) {
      if (this.exitError === null) return this.proc;
      // The process died after the handshake: this connection is FINISHED. A
      // replacement must be built by ensureConnection (which re-runs the full
      // initialize handshake); respawning in place would hand a fresh process
      // tools/call as its very first frame.
      throw new Error(`${this.exitError}; this connection is finished, the next explicit operation re-initializes a new process`);
    }
    if (!this.cfg.command) throw new Error("stdio server missing command");
    // Recursion guard by execution definition: renaming the server in the
    // config does not bypass this. Covers the direct entrypoint, entry-script
    // args (the installer generates `python <...>/bin/subagent-pi mcp`) and
    // `-m subagent_pi` module forms.
    const args = this.cfg.args ?? [];
    const base = (p: string) => p.split("/").pop();
    const selfReferencing =
      base(this.cfg.command) === SELF_BINARY ||
      args.some((a) => a === "-m" && args[args.indexOf(a) + 1] === SELF_MODULE) ||
      args.some((a) => base(a) === SELF_BINARY) ||
      (base(this.cfg.command) === "python" && args.some((a) => a === SELF_MODULE || a === SELF_BINARY));
    if (selfReferencing) throw new Error("refusing to start the subagent-pi management server inside a managed child");
    const env: Record<string, string> = {};
    for (const key of BASE_ENV) if (process.env[key]) env[key] = process.env[key] as string;
    Object.assign(env, this.cfg.env ?? {});
    const child = spawn(this.cfg.command, args, {
      cwd: this.cfg.cwd || undefined,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = child;
    if (child.pid) this.procStartTime = procStat(child.pid)?.startTime ?? null;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.resume(); // drain without retaining server output or secrets
    // The stdin Socket can fail ASYNCHRONOUSLY (server closed its read end; the
    // next write raises EPIPE). ChildProcess 'error' does not cover this and
    // try/catch only sees synchronous failures — this handler settles pending
    // requests deterministically and marks the connection dead for reconnect.
    child.stdin?.on("error", (err: Error) => {
      if (this.closed) return;
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      this.exitError = this.exitError ?? `stdio transport broken: ${code}`;
      this.failPending(`stdio transport broken (${code}); the call may or may not have reached the server`);
    });
    // Spawn failures and early exits reject waiters; never an unhandled 'error' crash.
    child.on("error", (err: Error) => {
      if (this.closed) return;
      this.exitError = `server failed to start: ${err.message.slice(0, 200)}`;
      this.failPending(this.exitError);
    });
    child.on("exit", () => {
      if (this.closed) return;
      this.exitError = this.exitError ?? "server process exited";
      this.failPending("stdio server exited before responding");
    });
    return child;
  }

  private sendFrame(frame: unknown): void {
    const child = this.ensureProcess();
    if (!child.stdin?.writable) {
      throw new Error("stdio transport is broken; reconnect required");
    }
    const line = JSON.stringify(frame) + "\n";
    if (child.stdin.writableLength + Buffer.byteLength(line) > MAX_STDIN_BUFFER) {
      const reason = "stdio outbound buffer limit reached; the call may or may not have reached the server";
      this.close(reason);
      throw new Error(reason);
    }
    child.stdin.write(line);
  }

  private onData(chunk: string): void {
    if (this.closed) return; // a replacement always gets a new connection object
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.failPending("stdio server emitted an oversized unframed line");
      try { this.proc?.kill("SIGKILL"); } catch { /* ignore */ }
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const id = typeof msg.id === "number" ? msg.id : undefined;
        const finish = id === undefined ? undefined : this.pending.get(id);
        if (finish) {
          try { finish(null, rpcResult(msg, id as number)); }
          catch (err) { finish(err as Error); }
        } else if (msg.id === undefined) {
          const method = (msg as unknown as { method?: string }).method;
          if (method === "notifications/tools/list_changed") this.invalidateCatalog(); // no model wakeup
        }
      } catch { /* non-JSON stdout line: ignore, never forward */ }
    }
  }

  async request(method: string, params: unknown, timeoutSec: number,
                opts: { notification?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (opts.signal?.aborted) throw new CancelledError(false);
    this.ensureProcess();
    const wireParams = this.era === "modern" ? this.withMeta(params) : params;
    if (opts.notification) {
      this.sendFrame({ jsonrpc: "2.0", method, params: wireParams });  // no pending entry; async EPIPE is the stdin listener's job
      return null;
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // Every exit (response, timeout, cancellation, write/exit failure, close)
      // releases the same request-owned timer, listener and pending entry.
      const finish = (error: Error | null, result?: unknown) => {
        this.pending.delete(id);
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error); else resolve(result);
      };
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        finish(new CancelledError(true));
        try { this.sendFrame({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }); } catch { /* best-effort */ }
      };
      const timer = setTimeout(() => {
        finish(new Error(`${method} timed out after ${timeoutSec}s`));
        // A server that stopped reading can retain timed-out frames in Node's
        // pipe forever. Discard that connection; never replay the mutation.
        if (this.proc?.stdin?.writableLength) this.close();
      }, timeoutSec * 1000);
      this.pending.set(id, finish);
      try {
        this.sendFrame({ jsonrpc: "2.0", id, method, params: wireParams });
      } catch (err) {
        if (this.pending.has(id)) finish(new Error(`failed to send ${method}: ${(err as Error).message.slice(0, 200)}`));
        return;
      }
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async initialize(): Promise<void> {
    if (this.era === "legacy") {
      await this.legacyHandshake();
      return;
    }
    // Auto lifecycle (current Codex V20260728): the first RPC of a
    // modern-enabled process is a side-effect-free server/discover carrying
    // full modern _meta. A valid DiscoverResult or a recognized modern error
    // keeps the modern era; any OTHER legacy-style error or a discovery
    // timeout falls back to the full legacy handshake. Discovery is
    // side-effect-free, never retried, and a tools/call is never replayed.
    let result: unknown;
    try {
      result = await this.request("server/discover", {}, this.cfg.startup_timeout_sec);
    } catch (err) {
      if (classifyProtocolError(err) === "modern") return;  // recognized modern error: no fallback
      this.era = "legacy";
      await this.legacyHandshake();
      return;
    }
    assertDiscoverResult(result);  // malformed success: protocol error, no fallback
  }

  private async legacyHandshake(): Promise<void> {
    await this.request("initialize", LEGACY_INIT, this.cfg.startup_timeout_sec);
    await this.request("notifications/initialized", {}, this.cfg.startup_timeout_sec, { notification: true });
  }

  close(reason = "connection closed"): void {
    const child = this.proc;
    // Capture the owned tree BEFORE asking an entry wrapper to exit. Descendants
    // can be reparented immediately; the worker's own process group remains intact.
    const root = child?.pid && this.procStartTime ? { pid: child.pid, startTime: this.procStartTime } : null;
    const descendants = root ? descendantsOf(root) : [];
    this.closed = true;
    this.proc = null;
    this.failPending(reason);
    if (child) {
      try { child.stdin?.destroy(); } catch { /* ignore */ }
      try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* ignore */ }
      for (const proc of descendants) signalIfSame(proc, "SIGTERM");
      if (root) signalIfSame(root, "SIGTERM");
      else try { child.kill("SIGTERM"); } catch { /* ignore */ }
      // A misbehaving MCP server must not survive failed initialization or
      // shutdown indefinitely. Keep ownership until exit, then release it.
      if (child.pid && (descendants.length || child.exitCode === null && child.signalCode === null)) {
        const kill = setTimeout(() => {
          for (const proc of descendants) signalIfSame(proc, "SIGKILL");
          if (child.exitCode === null && child.signalCode === null) {
            if (root) signalIfSame(root, "SIGKILL");
            else try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 1000);
        kill.unref();
        if (!descendants.length) child.once("exit", () => clearTimeout(kill));
      }
    }
  }
}

