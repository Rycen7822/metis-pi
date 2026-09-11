// Quota refresh orchestration: single in-flight refresh, last-good snapshot
// with a stale marker, bounded error classes, timer-free store (the owner
// decides when to call refresh; idle/settled boundaries live in extension.ts).
// A quota failure is a UI auxiliary error — it NEVER affects agent outcomes.

import { queryCodexQuota, type QuotaError } from "./codex-app-server.ts";
import type { CodexQuotaSnapshot, QuotaErrorClass, QuotaState } from "./types.ts";

export interface QuotaStoreOptions {
  /** Per-RPC / startup timeout (config quota.timeoutMs). */
  timeoutMs: number;
  /** Plugin version for the app-server initialize payload. */
  clientVersion?: string;
  /** Injectable query (tests); default: real codex app-server. */
  query?: (options: { timeoutMs: number; clientVersion?: string }) => Promise<CodexQuotaSnapshot>;
}

export class QuotaStore {
  readonly #timeoutMs: number;
  readonly #clientVersion: string | undefined;
  readonly #query: NonNullable<QuotaStoreOptions["query"]>;
  #quota: CodexQuotaSnapshot | undefined;
  #stale = false;
  #lastErrorClass: QuotaErrorClass | undefined;
  #lastErrorAt: number | undefined;
  #lastSuccessAt: number | undefined;
  #inFlight: Promise<void> | undefined;

  constructor(options: QuotaStoreOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#clientVersion = options.clientVersion;
    this.#query = options.query ?? ((q) => queryCodexQuota({ timeoutMs: q.timeoutMs, clientVersion: q.clientVersion }));
  }

  /** Fire one refresh. Concurrent calls coalesce into the in-flight one;
   * failures keep the last-good snapshot and set `stale`. Never throws. */
  refresh(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.#query({ timeoutMs: this.#timeoutMs, clientVersion: this.#clientVersion })
      .then((snapshot) => {
        this.#quota = snapshot;
        this.#stale = false;
        this.#lastSuccessAt = Date.now();
        this.#lastErrorClass = undefined;
        this.#lastErrorAt = undefined;
      })
      .catch((error: QuotaError) => {
        this.#stale = true;
        this.#lastErrorClass = error.errorClass ?? "rpc-error";
        this.#lastErrorAt = Date.now();
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  get refreshing(): boolean {
    return this.#inFlight !== undefined;
  }

  /** Read-only state for display + diagnostics. */
  state(): QuotaState {
    return {
      quota: this.#quota ? { ...this.#quota } : undefined,
      stale: this.#stale,
      lastErrorClass: this.#lastErrorClass,
      lastErrorAt: this.#lastErrorAt,
      lastSuccessAt: this.#lastSuccessAt,
    };
  }

  /** Age of the last success in ms (undefined = never succeeded). */
  lastSuccessAgeMs(now: number): number | undefined {
    return this.#lastSuccessAt === undefined ? undefined : Math.max(0, now - this.#lastSuccessAt);
  }

  reset(): void {
    // Session boundary: drop the snapshot (a new session re-refreshes).
    this.#quota = undefined;
    this.#stale = false;
    this.#lastErrorClass = undefined;
    this.#lastErrorAt = undefined;
    this.#lastSuccessAt = undefined;
  }
}
