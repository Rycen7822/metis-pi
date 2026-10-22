import { documentKey } from "./files.ts";
import type { LspDiagnostic, LspServerAdapter } from "./types.ts";

const PUBLISHED_DIAGNOSTICS_SETTLE_MS = 800;
type Publication = { version: number; diagnostics: LspDiagnostic[] };

/** Owns publication versions, waiters and grace/settle timers, independent of JSON-RPC requests. */
export class PublishedDiagnostics {
  #publications = new Map<string, Publication>();
  #waiters = new Map<string, Set<{ onPublish: (publication: Publication) => void; reject: (reason: unknown) => void }>>();
  #adapter: Pick<LspServerAdapter, "name" | "diagnosticsSettleMs">;
  #timeoutMs: number;

  constructor(adapter: Pick<LspServerAdapter, "name" | "diagnosticsSettleMs">, timeoutMs: number) {
    this.#adapter = adapter;
    this.#timeoutMs = timeoutMs;
  }

  get(uri: string) {
    return this.#publications.get(documentKey(uri));
  }

  publish(uri: string, diagnostics: LspDiagnostic[]) {
    const key = documentKey(uri);
    const publication = { version: (this.#publications.get(key)?.version ?? 0) + 1, diagnostics };
    this.#publications.set(key, publication);
    for (const waiter of [...this.#waiters.get(key) ?? []]) waiter.onPublish(publication);
  }

  rejectAll(message: string) {
    for (const waiters of this.#waiters.values()) {
      for (const waiter of [...waiters]) waiter.reject(new Error(message));
    }
    this.#waiters.clear();
  }

  wait(
    uri: string,
    fallback?: { afterVersion: number; diagnostics: LspDiagnostic[]; waitMs: number },
  ) {
    // See PUBLISHED_DIAGNOSTICS_SETTLE_MS. Bounded by #timeoutMs.
    const key = documentKey(uri);
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      let settleTimer: NodeJS.Timeout | undefined;
      let fallbackTimer: NodeJS.Timeout | undefined;
      let overallTimer: NodeJS.Timeout | undefined;
      let sawNonEmptyPublication = false;
      const afterVersion = fallback?.afterVersion ?? 0;

      const dispose = () => {
        if (settleTimer) clearTimeout(settleTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (overallTimer) clearTimeout(overallTimer);
        const set = this.#waiters.get(key);
        set?.delete(waiter);
        if (set && set.size === 0) this.#waiters.delete(key);
      };
      const settleWith = (diagnostics: LspDiagnostic[]) => {
        dispose();
        resolve(diagnostics);
      };
      const fail = (reason: unknown) => {
        dispose();
        reject(reason);
      };
      const onPublish = (publication: Publication) => {
        if (publication.version <= afterVersion) return;
        if (fallback && publication.diagnostics.length === 0 && !sawNonEmptyPublication) return;
        sawNonEmptyPublication ||= publication.diagnostics.length > 0;
        if (fallbackTimer) clearTimeout(fallbackTimer);
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(
          () => settleWith(this.#publications.get(key)?.diagnostics ?? []),
          this.#adapter.diagnosticsSettleMs ?? PUBLISHED_DIAGNOSTICS_SETTLE_MS,
        );
      };

      const waiter = { onPublish, reject: fail };
      const set = this.#waiters.get(key) ?? new Set<typeof waiter>();
      set.add(waiter);
      this.#waiters.set(key, set);

      if (fallback) {
        fallbackTimer = setTimeout(
          () => {
            const latest = this.#publications.get(key);
            settleWith(latest && latest.version > afterVersion ? latest.diagnostics : fallback.diagnostics);
          },
          Math.min(fallback.waitMs, this.#timeoutMs),
        );
      }
      overallTimer = setTimeout(() => {
        const latest = this.#publications.get(key);
        if (latest && latest.version > afterVersion) {
          settleWith(latest.diagnostics);
        } else if (fallback) {
          settleWith(fallback.diagnostics);
        } else {
          fail(new Error(`${this.#adapter.name} LSP did not return diagnostics for ${uri} before timeout.`));
        }
      }, this.#timeoutMs);

      const existing = this.#publications.get(key);
      if (existing) onPublish(existing);
    });
  }
}
