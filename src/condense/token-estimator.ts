import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";

export interface TokenComparison {
  piBefore: number;
  piAfter: number;
  proxyDelta: number;
  proxyBefore?: number;
  proxyAfter?: number;
}
type Job = {
  id: number; before: string[]; after: string[]; cacheKey: string;
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

// Keep brief pauses warm, but release the encoder after one minute without tokenization work.
const WORKER_IDLE_TIMEOUT_MS = 60_000;
// A flush alternates batch, stub and summary-overhead counts across concurrent candidates.
const MAX_CACHED_COMPARISONS = 64;
type ProxyCounts = Pick<TokenComparison, "proxyDelta" | "proxyBefore" | "proxyAfter">;

/** One lazy encoder; FIFO keeps concurrent summary validations from displacing each other. */
export class TokenEstimator {
  private worker?: Worker;
  private retiring?: Promise<number>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private active?: Job;
  private pending: Job[] = [];
  private nextId = 0;
  private cache = new Map<string, ProxyCounts>();

  compare(before: any[], after: any[], signal?: AbortSignal, absolute = false): Promise<TokenComparison | null> {
    if (signal?.aborted) return Promise.resolve(null);
    // Pi counts remain full-context facts; shared identities are stable within this synchronous call.
    const piCounts = new Map<any, number>();
    const pi = (messages: any[]) => messages.reduce((total, message) => {
      let count = piCounts.get(message);
      if (count === undefined) { count = estimateTokens(message); piCounts.set(message, count); }
      return total + count;
    }, 0);
    const piBefore = pi(before), piAfter = pi(after);
    let snapshot: [string[], string[]], cacheKey: string;
    try {
      // Count only model-facing fields. In particular, custom.details/display
      // and tool execution metadata are not evidence sent to the model.
      const normalize = (messages: any[]) => convertToLlm(messages).map(message => JSON.stringify(message.role === "toolResult"
        ? { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName,
          content: message.content, isError: message.isError }
        : { role: message.role, content: message.content }));
      let left = before, right = after;
      if (!absolute) {
        // The worker delta is additive per message. Cancel shared objects before serializing or
        // cloning them, preserving multiplicity; different objects still get full encoder checks.
        const copies = new Map<any, number>();
        for (const message of before) copies.set(message, (copies.get(message) ?? 0) + 1);
        for (const message of after) copies.set(message, (copies.get(message) ?? 0) - 1);
        const remaining = (messages: any[], sign: number) => messages.filter(message => {
          const count = copies.get(message) ?? 0;
          if (count * sign <= 0) return false;
          copies.set(message, count - sign);
          return true;
        });
        left = remaining(before, 1); right = remaining(after, -1);
      }
      snapshot = [normalize(left), normalize(right)];
      // Runtime owns full-source authorization. Encoder memoization counts only model-facing
      // fields, so render timestamps and display metadata must not force another measurement.
      const fingerprint = (messages: string[]) => {
        const hash = createHash("sha256");
        for (const message of messages) hash.update(message).update("\n");
        return hash.digest("hex");
      };
      cacheKey = `${absolute}:` + fingerprint(snapshot[0]) + ":" + fingerprint(snapshot[1]);
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return Promise.resolve({ piBefore, piAfter, ...cached });
      }
      // Immutable counted text snapshots queued work now; the worker need not clone objects or serialize it again.
    }
    catch { return Promise.resolve(null); }
    return new Promise(resolve => {
      const job: Job = { id: ++this.nextId, before: snapshot[0], after: snapshot[1], cacheKey, signal, resolve,
        piBefore, piAfter, absolute,
        abort: () => this.clear() };
      signal?.addEventListener("abort", job.abort, { once: true });
      if (this.active || this.retiring) this.pending.push(job);
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
    this.cancelIdleTimer();
    this.active = job;
    try {
      if (!this.worker) {
        const worker = new Worker(new URL("./token-worker.mjs", import.meta.url));
        this.worker = worker;
        worker.on("message", result => {
          const current = this.active;
          if (this.worker !== worker || !current || current.id !== result.id) return;
          if (result.error || !Number.isFinite(result.delta)) { this.clear(); return; }
          const measured: TokenComparison = { piBefore: current.piBefore, piAfter: current.piAfter,
            proxyDelta: result.delta, proxyBefore: result.before, proxyAfter: result.after };
          this.cache.delete(current.cacheKey);
          this.cache.set(current.cacheKey, {
            proxyDelta: measured.proxyDelta, proxyBefore: measured.proxyBefore, proxyAfter: measured.proxyAfter,
          });
          if (this.cache.size > MAX_CACHED_COMPARISONS) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
          }
          this.active = undefined;
          this.finish(current, measured);
          const next = this.pending.shift();
          if (next) this.start(next);
          else this.scheduleIdleRelease(worker);
        });
        worker.on("error", () => { if (this.worker === worker) this.clear(); });
        worker.on("exit", () => { if (this.worker === worker) this.clear(); });
      }
      this.worker.ref();
      this.worker.postMessage({ id: job.id, before: job.before, after: job.after, absolute: job.absolute });
    } catch { this.clear(); }
  }

  private cancelIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleRelease(worker: Worker) {
    worker.unref();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.worker === worker && !this.active && !this.pending.length) this.retireWorker();
    }, WORKER_IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private retireWorker() {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    worker.unref();
    const retiring = worker.terminate();
    this.retiring = retiring;
    void retiring.then(() => {
      if (this.retiring !== retiring) return;
      this.retiring = undefined;
      const next = this.pending.shift();
      if (next) this.start(next);
    }, () => {
      if (this.retiring !== retiring) return;
      this.retiring = undefined;
      this.clear();
    });
  }

  clear() {
    this.cancelIdleTimer();
    this.cache.clear();
    if (this.active) this.finish(this.active, null);
    for (const job of this.pending) this.finish(job, null);
    this.active = undefined;
    this.pending = [];
    this.retireWorker();
  }
}
