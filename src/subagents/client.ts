import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export interface SubagentTool {
  name: string; description: string; inputSchema: TSchema; outputSchema: TSchema;
  _op: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export interface RuntimePackage { root: string; tools: SubagentTool[]; baseEnvKeys: string[]; maxFrame: number }
export function runtimePackage(): RuntimePackage {
  const root = fileURLToPath(new URL("./core/", import.meta.url));
  const metadata = JSON.parse(readFileSync(join(root, "tools.json"), "utf8"));
  if (metadata.hostProtocol !== 1) throw new Error("Metis subagent schema needs host protocol 1; run npm run prepare:subagents");
  return { root, ...metadata };
}
export class RuntimeError extends Error {
  readonly code: string;
  readonly agent_id?: string;
  readonly run_id?: string;
  constructor(error: { code: string; message: string; agent_id?: string; run_id?: string }) {
    const ids = [error.agent_id && `agent_id=${error.agent_id}`, error.run_id && `run_id=${error.run_id}`].filter(Boolean);
    super(error.message + (ids.length ? ` (${ids.join(', ')})` : ""));
    this.code = error.code; this.agent_id = error.agent_id; this.run_id = error.run_id;
  }
}
interface Pending { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; cleanup: () => void }

export class SubagentClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private ended = false;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private bootTimeout = 120;
  private readonly pending = new Map<string, Pending>();
  private readonly runtime: RuntimePackage;
  private ctx: ExtensionContext;
  private readonly agentDir: string;
  private readonly attached: (scope: string) => void;
  private readonly lease = randomUUID();
  scope?: string;

  constructor(runtime: RuntimePackage, ctx: ExtensionContext, agentDir: string, scope: string | undefined, attached: (scope: string) => void) {
    this.runtime = runtime; this.ctx = ctx; this.agentDir = agentDir; this.scope = scope; this.attached = attached;
  }
  update(ctx: ExtensionContext) { this.ctx = ctx; }
  private fail(error: Error) {
    this.ended = true;
    for (const call of this.pending.values()) { call.cleanup(); call.reject(error); }
    this.pending.clear();
    this.child?.stdin.destroy();
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      if (end >= this.runtime.maxFrame) { this.fail(new Error("Subagent response exceeds frame limit")); return; }
      const line = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end + 1);
      try {
        const message = JSON.parse(line.toString("utf8"));
        const call = this.pending.get(message.id);
        if (!call) {
          // A cancelled wait may have won the response race. It did not reach
          // Pi, so its reserved attention can be made eligible again.
          const ticket = message.result?._pi_delivery;
          if (ticket && this.scope && !this.ended) for (const receipt of ticket.receipts ?? [ticket.id]) void this.rpc("pi_release", { receipt }).catch(() => {});
          continue;
        }
        this.pending.delete(message.id); call.cleanup();
        if (message.ok) call.resolve(message.result);
        else call.reject(new RuntimeError(message.error));
      } catch { this.fail(new Error("Invalid subagent protocol response")); return; }
    }
    if (this.buffer.length >= this.runtime.maxFrame) this.fail(new Error("Subagent response exceeds frame limit"));
  }
  private send(frame: object) {
    const body = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(body) > this.runtime.maxFrame) throw new Error("Subagent request exceeds frame limit");
    if (!this.child || this.ended || this.child.stdin.writableLength + Buffer.byteLength(body) > this.runtime.maxFrame)
      throw new Error("Subagent connection unavailable; inspect before retrying a mutation");
    this.child.stdin.write(body, error => { if (error) this.fail(error); });
  }
  private rpc(operation: string, params: object, signal?: AbortSignal, extra?: object): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Subagent wait cancelled"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many subagent requests"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const call = this.pending.get(id); if (!call) return;
        this.pending.delete(id); call.cleanup();
        try { this.send({ cancel: id }); } catch {}
        reject(signal?.reason ?? new Error("Subagent request cancelled; mutation may have committed"));
      };
      const op = this.runtime.tools.find(tool => tool.name === operation)?._op ?? operation;
      const waitSeconds = (params as { timeout_seconds?: number }).timeout_seconds ?? 600;
      const boot = ["spawn", "message", "followup", "soft_interrupt"].includes(op);
      const seconds = op === "wait" ? Math.max(45, waitSeconds + 10) : boot ? this.bootTimeout : 45;
      const timer = setTimeout(cancel, (seconds + 50) * 1000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ id, operation, params, ...extra }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  private connect(): Promise<void> {
    return this.ready ??= (async () => {
      if (this.ended) throw new Error("Subagent frontend closed; reload to reconnect");
      const child = this.child = spawn("python3", [join(this.runtime.root, "bin/subagent-pi"), "--home", join(this.agentDir, "subagent-pi"), "pi-host"], { cwd: this.ctx.cwd, stdio: "pipe" });
      child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
      child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2048); });
      child.on("error", error => this.fail(new Error(`Subagents require Linux and Python 3.11+: ${error.message}`)));
      child.on("exit", () => this.fail(new Error(`Subagent bridge exited; inspect mutations before retrying. ${this.stderr}`)));
      const env = Object.fromEntries(this.runtime.baseEnvKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
      const result = await this.rpc("initialize", { cwd: this.ctx.cwd, label: "Pi subagents", ...(this.scope ? { scope: this.scope } : {}) }, undefined, { source: { env,
        project_trust: { cwd: realpathSync(this.ctx.cwd), trusted: this.ctx.isProjectTrusted() }, parent: {
        kind: "pi", session_id: this.ctx.sessionManager.getSessionId(), agent_dir: this.agentDir,
        session_file: this.ctx.sessionManager.getSessionFile() ?? "", sdk_path: join(getPackageDir(), "dist/index.js"),
        node_path: process.execPath, lease: this.lease, model: this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : null,
      } } });
      this.scope = result.scope as string; this.attached(this.scope);
      this.bootTimeout = result.boot_timeout as number;
    })();
  }
  async call(operation: string, params: object, signal?: AbortSignal, extra?: object) {
    await this.connect();
    return this.rpc(operation, params, signal, { model: this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : null, ...extra });
  }
  async close() {
    if (!this.child) { this.ended = true; return; }
    this.child.stdin.end();
    const child = this.child;
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
      }, 2500);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
    });
    this.fail(new Error("Subagent frontend detached; background tasks remain in the daemon"));
  }
}
