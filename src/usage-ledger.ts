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

/** Usage-dedup key grammar shared by live confirmations (extension.ts) and
 * session-file rebuilds (UsageLedger.rebuild) — both MUST produce the same
 * key for the same response or a replay double-counts. Covers only the two
 * IDENTIFIED forms; unidentified fallbacks stay local by design (live:
 * random `u-` key that never dedups; rebuild: stable entry-id key).
 * `${provider}:${responseId}` (namespaced — responseIds can collide across
 * providers), else `m-${timestamp}` when the host gives no response id. */
export function usageKeyOf(record: Record<string, unknown>): { key: string; identified: boolean } | undefined {
  const responseId = typeof record.responseId === "string" && record.responseId ? record.responseId : undefined;
  if (responseId) return { key: `${String(record.provider)}:${responseId}`, identified: true };
  const timestamp = record.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return { key: `m-${timestamp}`, identified: true };
  return undefined;
}

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

/** Keep the same token boundary for streaming metrics and confirmed usage. */
export function sanitizeUsage(raw: RawUsage): Partial<Omit<UsageRecord, "costTotal">> {
  const usage: Partial<Omit<UsageRecord, "costTotal">> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = amount(raw[key]);
    if (value !== undefined) usage[key] = value;
  }
  return usage;
}

/** Sanitize a raw usage object; undefined when nothing valid is present. */
export function toUsageRecord(raw: RawUsage | undefined): UsageRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const tokens = sanitizeUsage(raw);
  if (Object.keys(tokens).length === 0) return undefined;
  return { ...ZERO, ...tokens, costTotal: amount(raw.cost?.total) };
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
  /** Corrections preserve insertion order: an older request stays older. */
  #lastKey: string | undefined;
  #totals: UsageRecord | undefined;

  /** Confirm final usage for a request/entry. Same key replaces (correction),
   * never double-counts. Returns false when the usage carried no valid data. */
  confirm(key: string, raw: RawUsage | undefined): boolean {
    const rec = toUsageRecord(raw);
    if (!rec) return false;
    if (!this.#confirmed.has(key)) this.#lastKey = key;
    this.#confirmed.set(key, rec);
    this.#totals = undefined;
    return true;
  }

  /** Recompute only after confirmations change; scrolling only copies the
   * cached totals, so callers cannot mutate the next frame's data. */
  totals(): UsageRecord {
    if (!this.#totals) {
      this.#totals = { ...ZERO };
      for (const rec of this.#confirmed.values()) addInto(this.#totals, rec);
    }
    return { ...this.#totals };
  }

  /** Cache rate of the most recent request; unknown for an empty session. */
  cacheRateLast(): number | null {
    return cacheHitRate(this.#lastKey === undefined ? undefined : this.#confirmed.get(this.#lastKey));
  }

  /** Rebuild from session entries (init/resume/tree/compact). Idempotent with
   * live confirmations through the shared key space. */
  rebuild(entries: unknown[]): void {
    this.reset();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.type === "compaction" || record.type === "branch_summary") {
        this.confirm(`e-${String(record.id)}`, record.usage as RawUsage | undefined);
        continue;
      }
      if (record.type !== "message") continue;
      const message = record.message as Record<string, unknown> | undefined;
      if (!message || message.role !== "assistant") continue;
      const identified = usageKeyOf(message);
      const key = identified ? identified.key : `m-${String(message.timestamp ?? record.id)}`;
      this.confirm(key, message.usage as RawUsage | undefined);
    }
  }

  reset(): void {
    this.#confirmed.clear();
    this.#lastKey = undefined;
    this.#totals = undefined;
  }

  /** Diagnostics: how many distinct requests are confirmed. */
  get confirmedCount(): number {
    return this.#confirmed.size;
  }
}
