import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { metisConfigPath } from "../metis-config.ts";

export interface SubagentTool {
  name: string; description: string; inputSchema: TSchema; outputSchema: TSchema;
  _op: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export interface RuntimePackage { root: string; tools: SubagentTool[]; baseEnvKeys: string[]; scopeEnvKeys: string[]; maxFrame: number }
export function runtimePackage(): RuntimePackage {
  const root = fileURLToPath(new URL("./core/", import.meta.url));
  const metadata = JSON.parse(readFileSync(join(root, "tools.json"), "utf8"));
  if (metadata.hostProtocol !== 1 || !Array.isArray(metadata.scopeEnvKeys)) throw new Error("Metis subagent schema needs host protocol 1 with scopeEnvKeys; run npm run prepare:subagents");
  return { root, ...metadata };
}
export class RuntimeError extends Error {
  readonly code: string;
  readonly agent_id?: string;
  readonly run_id?: string;
  readonly request_id?: string;
  constructor(error: { code: string; message: string; agent_id?: string; run_id?: string; request_id?: string }) {
    const ids = [error.agent_id && `agent_id=${error.agent_id}`, error.run_id && `run_id=${error.run_id}`, error.request_id && `request_id=${error.request_id}`].filter(Boolean);
    super(error.message + (ids.length ? ` (${ids.join(', ')})` : ""));
    this.code = error.code; this.agent_id = error.agent_id; this.run_id = error.run_id; this.request_id = error.request_id;
  }
}
export function isDaemonIdle(error: unknown): error is RuntimeError {
  return error instanceof RuntimeError && error.code === "daemon_idle";
}
interface Pending { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; cleanup: () => void }
interface Bridge { child: ChildProcessWithoutNullStreams; ready?: Promise<void>; buffer: Buffer; stderr: string }

export class SubagentClient {
  private bridge?: Bridge;
  private parking?: Promise<void>;
  private reconnect = false;
  private ended = false;
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
  private fail(bridge: Bridge | undefined, error: Error) {
    if (bridge !== this.bridge) return; // All transport failures, including late writes, have one owner.
    this.ended = true;
    for (const call of this.pending.values()) { call.cleanup(); call.reject(error); }
    bridge?.child.stdin.destroy();
  }
  private receive(bridge: Bridge, chunk: Buffer) {
    if (bridge !== this.bridge) return;
    bridge.buffer = Buffer.concat([bridge.buffer, chunk]);
    let end: number;
    while ((end = bridge.buffer.indexOf(10)) >= 0) {
      if (end >= this.runtime.maxFrame) { this.fail(bridge, new Error("Subagent response exceeds frame limit")); return; }
      const line = bridge.buffer.subarray(0, end); bridge.buffer = bridge.buffer.subarray(end + 1);
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
        call.cleanup();
        if (message.ok) call.resolve(message.result);
        else call.reject(new RuntimeError(message.error));
      } catch { this.fail(bridge, new Error("Invalid subagent protocol response")); return; }
    }
    if (bridge.buffer.length >= this.runtime.maxFrame) this.fail(bridge, new Error("Subagent response exceeds frame limit"));
  }
  private send(frame: object) {
    const body = JSON.stringify(frame) + "\n", bridge = this.bridge;
    if (Buffer.byteLength(body) > this.runtime.maxFrame) throw new Error("Subagent request exceeds frame limit");
    if (!bridge || this.ended || bridge.child.stdin.writableLength + Buffer.byteLength(body) > this.runtime.maxFrame)
      throw new Error("Subagent connection unavailable; inspect before retrying a mutation");
    bridge.child.stdin.write(body, error => { if (error) this.fail(bridge, error); });
  }
  private rpc(operation: string, params: object, signal?: AbortSignal, extra?: object): Promise<Record<string, unknown>> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Subagent wait cancelled"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many subagent requests"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const call = this.pending.get(id); if (!call) return;
        call.cleanup();
        try { this.send({ cancel: id }); } catch {}
        reject(signal?.reason ?? new Error("Subagent request cancelled; mutation may have committed"));
      };
      const op = this.runtime.tools.find(tool => tool.name === operation)?._op ?? operation;
      const waitSeconds = (params as { timeout_seconds?: number }).timeout_seconds ?? 600;
      const boot = ["spawn", "message", "followup", "soft_interrupt"].includes(op);
      const seconds = op === "wait" ? Math.max(45, waitSeconds + 10) : boot ? this.bootTimeout : 45;
      const timer = setTimeout(cancel, (seconds + 50) * 1000);
      const cleanup = () => { this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ id, operation, params, ...extra }); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  private async connect(passive = false): Promise<void> {
    if (this.parking) await this.parking;
    if (this.ended) throw new Error("Subagent frontend closed; reload to reconnect");
    if (!this.bridge) {
      const child = spawn("python3", [join(this.runtime.root, "bin/subagent-pi"), "--home", join(this.agentDir, "subagent-pi"), "pi-host"], { cwd: this.ctx.cwd, stdio: "pipe", env: { ...process.env, METIS_PI_CONFIG: metisConfigPath(this.agentDir) } });
      const bridge = this.bridge = { child, buffer: Buffer.alloc(0), stderr: "" };
      child.stdout.on("data", (chunk: Buffer) => this.receive(bridge, chunk));
      child.stderr.on("data", (chunk: Buffer) => { bridge.stderr = (bridge.stderr + chunk.toString("utf8")).slice(-2048); });
      child.on("error", error => this.fail(bridge, new Error(`Subagents require Linux and Python 3.11+: ${error.message}`)));
      child.on("exit", () => this.fail(bridge, new Error(`Subagent bridge exited; inspect mutations before retrying. ${bridge.stderr}`)));
    }
    const bridge = this.bridge;
    if (bridge.ready) return bridge.ready;
    const reconnect = this.reconnect;
    return bridge.ready = (async () => {
      const env = Object.fromEntries(this.runtime.scopeEnvKeys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
      // An unconfirmed bind may already have committed: never regain takeover rights.
      this.reconnect = true;
      const result = await this.rpc("initialize", { cwd: this.ctx.cwd, label: "Pi subagents", ...(this.scope ? { scope: this.scope } : {}) }, undefined, { passive, reconnect, source: { env,
        project_trust: { cwd: realpathSync(this.ctx.cwd), trusted: this.ctx.isProjectTrusted() }, parent: {
        kind: "pi", session_id: this.ctx.sessionManager.getSessionId(), agent_dir: this.agentDir,
        session_file: this.ctx.sessionManager.getSessionFile() ?? "", sdk_path: join(getPackageDir(), "dist/index.js"),
        node_path: process.execPath, lease: this.lease, model: this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : null,
      } } });
      this.scope = result.scope as string; this.bootTimeout = result.boot_timeout as number;
      this.attached(this.scope);
    })().catch(error => {
      if (isDaemonIdle(error) && this.bridge === bridge) {
        bridge.ready = undefined; this.reconnect = reconnect; // Proven pre-admission rejection only.
      }
      throw error;
    });
  }
  async call(operation: string, params: object, signal?: AbortSignal, extra?: object) {
    const passive = (extra as { passive?: boolean } | undefined)?.passive === true;
    try { await this.connect(passive); }
    catch (error) { if (!passive && isDaemonIdle(error)) await this.connect(); else throw error; }
    return this.rpc(operation, params, signal, { model: this.ctx.model ? { provider: this.ctx.model.provider, id: this.ctx.model.id } : null, ...extra });
  }
  async park() {
    if (this.pending.size || !this.bridge || this.ended) return;
    const { child } = this.bridge;
    this.send({ park: true }); // Drop transport, not the frontend's logical lease.
    this.bridge = undefined;
    this.parking = this.stopChild(child);
    try { await this.parking; } finally { this.parking = undefined; }
  }
  private async stopChild(child: ChildProcessWithoutNullStreams) {
    child.stdin.end();
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 1500);
      }, 2500);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(killTimer); resolve(); });
    });
  }
  async close() {
    this.ended = true;
    if (this.parking) await this.parking;
    if (this.bridge) await this.stopChild(this.bridge.child);
    this.fail(this.bridge, new Error("Subagent frontend detached; background tasks remain in the daemon"));
  }
}
