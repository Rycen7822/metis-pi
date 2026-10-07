import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";

export interface TokenComparison {
  fingerprint: string;
  piBefore: number;
  piAfter: number;
  proxyDelta: number;
  proxyBefore?: number;
  proxyAfter?: number;
}
type Job = {
  id: number; before: any[]; after: any[]; fingerprint: string;
  piBefore: number; piAfter: number; absolute: boolean;
  signal?: AbortSignal; abort: () => void;
  resolve: (result: TokenComparison | null) => void;
};

/** Content identity, including protection, recovery references and effective edits. */
export function projectionFingerprint(messages: any[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n");
  return hash.digest("hex");
}

/** One lazy encoder; FIFO keeps concurrent summary validations from displacing each other. */
export class TokenEstimator {
  private worker?: Worker;
  private active?: Job;
  private pending: Job[] = [];
  private nextId = 0;
  private cache?: TokenComparison;

  compare(before: any[], after: any[], signal?: AbortSignal, absolute = false): Promise<TokenComparison | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const fingerprint = `${absolute}:` + projectionFingerprint(before) + ":" + projectionFingerprint(after);
    if (this.cache?.fingerprint === fingerprint) return Promise.resolve(this.cache);
    let snapshot: [any[], any[]];
    try {
      // Count only model-facing fields. In particular, custom.details/display
      // and tool execution metadata are not evidence sent to the model.
      const normalize = (messages: any[]) => convertToLlm(messages).map(message => message.role === "toolResult"
        ? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName,
          content: message.content, isError: message.isError }
        : { role: message.role, content: message.content });
      snapshot = structuredClone([normalize(before), normalize(after)]);
    }
    catch { return Promise.resolve(null); }
    return new Promise(resolve => {
      const job: Job = { id: ++this.nextId, before: snapshot[0], after: snapshot[1], fingerprint, signal, resolve,
        piBefore: before.reduce((n, m) => n + estimateTokens(m), 0),
        piAfter: after.reduce((n, m) => n + estimateTokens(m), 0), absolute,
        abort: () => this.clear() };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (this.active) this.pending.push(job);
      else this.start(job);
    });
  }

  async measure(before: any[], after: any[], signal?: AbortSignal): Promise<{ before: number; after: number } | null> {
    const result = await this.compare(before, after, signal, true);
    return result?.proxyBefore !== undefined && result.proxyAfter !== undefined
      ? { before: result.proxyBefore, after: result.proxyAfter } : null;
  }

  private finish(job: Job, result: TokenComparison | null) {
    job.signal?.removeEventListener("abort", job.abort);
    job.resolve(result);
  }

  private start(job: Job) {
    this.active = job;
    try {
      if (!this.worker) {
        const worker = new Worker(new URL("./token-worker.mjs", import.meta.url));
        this.worker = worker;
        worker.on("message", result => {
          const current = this.active;
          if (this.worker !== worker || !current || current.id !== result.id) return;
          if (result.error || !Number.isFinite(result.delta)) { this.clear(); return; }
          const measured: TokenComparison = { fingerprint: current.fingerprint,
            piBefore: current.piBefore, piAfter: current.piAfter,
            proxyDelta: result.delta, proxyBefore: result.before, proxyAfter: result.after };
          this.cache = measured;
          this.active = undefined;
          this.finish(current, measured);
          const next = this.pending.shift();
          if (next) this.start(next);
          else worker.unref();
        });
        worker.on("error", () => { if (this.worker === worker) this.clear(); });
        worker.on("exit", () => { if (this.worker === worker) this.clear(); });
      }
      this.worker.ref();
      this.worker.postMessage({ id: job.id, before: job.before, after: job.after, absolute: job.absolute });
    } catch { this.clear(); }
  }

  clear() {
    const worker = this.worker;
    this.worker = undefined;
    this.cache = undefined;
    if (this.active) this.finish(this.active, null);
    for (const job of this.pending) this.finish(job, null);
    this.active = undefined;
    this.pending = [];
    if (worker) { worker.unref(); void worker.terminate(); }
  }
}
