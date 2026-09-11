// Session-scope usage ledger. Scope discipline (three scopes never mixed):
//   context  — live ctx.getContextUsage() (host), shown as ctx NNk/WINDOW · pct%
//   session  — THIS ledger: standard session entries' usage on the active
//              session file (assistant messages + compaction/branch_summary).
//   interaction — UiMetrics, from message_end events of the current run.
// Dedup keys: entry.id for persisted entries, `${provider}:${responseId}` for
// live messages (responseIds can collide ACROSS providers — always namespace),
// `m-${timestamp}` as the no-id fallback (host entry timestamps are stable).
// Live confirmations and rebuilds share the same key space, so a replay never
// double-counts; a later confirmation with the same key REPLACES (final usage
// may correct an earlier partial). Our own summary CustomEntry is excluded.

/** Narrow structural usage shape (matches the host Usage fields we sum). */
export interface RawUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

export interface UsageRecord {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Host-reported cost total; undefined when unknown/not reported. */
  costTotal: number | undefined;
}

const ZERO: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: undefined };

function amount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Sanitize a raw usage object; null when nothing valid is present. */
export function toUsageRecord(raw: RawUsage | undefined): UsageRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = amount(raw.input);
  const output = amount(raw.output);
  const cacheRead = amount(raw.cacheRead);
  const cacheWrite = amount(raw.cacheWrite);
  const costTotal = amount(raw.cost?.total);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    costTotal,
  };
}

function addInto(target: UsageRecord, rec: UsageRecord): void {
  target.input += rec.input;
  target.output += rec.output;
  target.cacheRead += rec.cacheRead;
  target.cacheWrite += rec.cacheWrite;
  if (rec.costTotal !== undefined) {
    target.costTotal = (target.costTotal ?? 0) + rec.costTotal;
  }
}

/** cacheRead / (input + cacheRead + cacheWrite) × 100. Null when the
 * denominator is 0 or nothing valid was reported — never fabricated. */
export function cacheHitRate(rec: UsageRecord | undefined): number | null {
  if (!rec) return null;
  const denominator = rec.input + rec.cacheRead + rec.cacheWrite;
  if (denominator <= 0) return null;
  return (rec.cacheRead / denominator) * 100;
}

export class UsageLedger {
  #confirmed = new Map<string, UsageRecord>();
  /** Insertion order — the last confirmed key is the "last request". */
  #order: string[] = [];
  #previewSeq: number | undefined;
  #preview: UsageRecord | undefined;

  /** Confirm final usage for a request/entry. Same key replaces (correction),
   * never double-counts. Returns false when the usage carried no valid data. */
  confirm(key: string, raw: RawUsage | undefined): boolean {
    const rec = toUsageRecord(raw);
    if (!rec) return false;
    if (!this.#confirmed.has(key)) this.#order.push(key);
    this.#confirmed.set(key, rec);
    return true;
  }

  /** Replace the in-flight preview contribution (streaming usage is a
   * CUMULATIVE snapshot per request — never sum deltas). */
  preview(seq: number, raw: RawUsage | undefined): void {
    const rec = toUsageRecord(raw);
    if (!rec) return;
    this.#previewSeq = seq;
    this.#preview = rec;
  }

  clearPreview(seq: number): void {
    if (this.#previewSeq === seq) {
      this.#previewSeq = undefined;
      this.#preview = undefined;
    }
  }

  /** Confirmed totals only (the honest ledger). */
  totals(): UsageRecord {
    const total: UsageRecord = { ...ZERO, costTotal: undefined };
    for (const rec of this.#confirmed.values()) addInto(total, rec);
    return total;
  }

  /** Current preview contribution, if a request is in flight. */
  previewRecord(): UsageRecord | undefined {
    return this.#preview;
  }

  /** Most recent confirmed request (basis for cache(last)); undefined when
   * the session has none yet — shown as unknown, not as a stale rate. */
  lastRequest(): UsageRecord | undefined {
    for (let i = this.#order.length - 1; i >= 0; i -= 1) {
      const rec = this.#confirmed.get(this.#order[i]);
      if (rec) return rec;
    }
    return undefined;
  }

  cacheRateLast(): number | null {
    return cacheHitRate(this.lastRequest());
  }

  cacheRateSession(): number | null {
    return cacheHitRate(this.totals());
  }

  /** Rebuild from session entries (init/resume/tree/compact). Idempotent with
   * live confirmations through the shared key space. */
  rebuild(entries: unknown[], ownCustomType: string): void {
    this.#confirmed.clear();
    this.#order = [];
    this.#previewSeq = undefined;
    this.#preview = undefined;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.type === "custom") {
        // Never count our own UI summary back into the totals.
        if (record.customType === ownCustomType) continue;
        continue;
      }
      if (record.type === "compaction" || record.type === "branch_summary") {
        this.confirm(`e-${String(record.id)}`, record.usage as RawUsage | undefined);
        continue;
      }
      if (record.type !== "message") continue;
      const message = record.message as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;
      const responseId = typeof message.responseId === "string" && message.responseId
        ? `${String(message.provider)}:${message.responseId}`
        : undefined;
      const key = responseId ?? `m-${String(message.timestamp ?? record.id)}`;
      this.confirm(key, message.usage as RawUsage | undefined);
    }
  }

  reset(): void {
    this.#confirmed.clear();
    this.#order = [];
    this.#previewSeq = undefined;
    this.#preview = undefined;
  }

  /** Diagnostics: how many distinct requests are confirmed. */
  get confirmedCount(): number {
    return this.#confirmed.size;
  }
}
