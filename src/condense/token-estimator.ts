import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

export interface TokenComparison {
  fingerprint: string;
  piBefore: number;
  piAfter: number;
  proxyDelta: number;
}
type Job = {
  id: number; before: any[]; after: any[]; fingerprint: string;
  piBefore: number; piAfter: number;
  signal?: AbortSignal; abort: () => void;
  resolve: (result: TokenComparison | null) => void;
};

/** Content identity, including protection, recovery references and effective edits. */
export function projectionFingerprint(messages: any[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(JSON.stringify(message)).update("\n");
  return hash.digest("hex");
}

/** One lazy encoder, one active comparison and one replaceable latest request. */
export class TokenEstimator {
  private worker?: Worker;
  private active?: Job;
  private pending?: Job;
  private nextId = 0;
  private cache?: TokenComparison;

  compare(before: any[], after: any[], signal?: AbortSignal): Promise<TokenComparison | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const fingerprint = projectionFingerprint(before) + ":" + projectionFingerprint(after);
    if (this.cache?.fingerprint === fingerprint) return Promise.resolve(this.cache);
    let snapshot: [any[], any[]];
    try { snapshot = structuredClone([before, after]); }
    catch { return Promise.resolve(null); }
    return new Promise(resolve => {
      const job: Job = { id: ++this.nextId, before: snapshot[0], after: snapshot[1], fingerprint, signal, resolve,
        piBefore: before.reduce((n, m) => n + estimateTokens(m), 0),
        piAfter: after.reduce((n, m) => n + estimateTokens(m), 0),
        abort: () => this.clear() };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (this.active) {
        if (this.pending) this.finish(this.pending, null);
        this.pending = job;
      } else this.start(job);
    });
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
            proxyDelta: result.delta };
          this.cache = measured;
          this.active = undefined;
          this.finish(current, measured);
          const next = this.pending;
          this.pending = undefined;
          if (next) this.start(next);
          else worker.unref();
        });
        worker.on("error", () => { if (this.worker === worker) this.clear(); });
        worker.on("exit", () => { if (this.worker === worker) this.clear(); });
      }
      this.worker.ref();
      this.worker.postMessage({ id: job.id, before: job.before, after: job.after });
    } catch { this.clear(); }
  }

  clear() {
    const worker = this.worker;
    this.worker = undefined;
    this.cache = undefined;
    if (this.active) this.finish(this.active, null);
    if (this.pending) this.finish(this.pending, null);
    this.active = this.pending = undefined;
    if (worker) { worker.unref(); void worker.terminate(); }
  }
}
