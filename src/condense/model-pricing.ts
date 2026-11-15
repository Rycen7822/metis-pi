import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Model as EconomicModel } from "./rewrite-policy.ts";

type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };
type Price = { provider: string; id: string; host?: string; source: "pi" | "models.dev"; cost: Cost;
  tiers?: { after: number; cost: Cost }[] };
const MAX_BYTES = 32 * 1024 * 1024;
const table = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function host(url: unknown): string | undefined {
  try { return typeof url === "string" ? new URL(url).hostname : undefined; } catch { return undefined; }
}
function cost(value: unknown, snake = false, allowFree = false): Cost | undefined {
  if (!table(value) || !number(value.input) || !number(value.output) || (!allowFree && value.input + value.output === 0)) return;
  const read = value[snake ? "cache_read" : "cacheRead"], write = value[snake ? "cache_write" : "cacheWrite"];
  return { input: value.input, output: value.output,
    cacheRead: number(read) ? read : value.input / 10, cacheWrite: number(write) ? write : value.input };
}
function nativePrice(model: EconomicModel): Price | undefined {
  const rates = cost({ ...model.cost, ...model.priceTiers?.[0]?.cost });
  if (!rates) return;
  const tiers: NonNullable<Price["tiers"]> = [];
  const schedule = model.priceTiers?.slice(1)
    ?? model.cost?.tiers?.map(tier => ({ after: tier.inputTokensAbove, cost: tier })) ?? [];
  for (const tier of schedule) {
    if (!number(tier.after)) continue;
    const next = cost({ ...rates, ...tier.cost });
    if (next) tiers.push({ after: tier.after, cost: next });
  }
  return { provider: model.provider, id: model.id, host: host(model.baseUrl), source: "pi", cost: rates,
    ...(tiers.length ? { tiers: tiers.sort((a, b) => a.after - b.after) } : {}) };
}
const leaf = (id: string) => (id.split("/").at(-1) ?? id).toLowerCase();
function pattern(id: string): RegExp {
  const parts = leaf(id).split(/[\s._:-]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Formatting and dated aliases only: never make mini/pro/flash qualifiers optional.
  return new RegExp(`^${parts.join("[\\s._:-]+")}(?:[-@:]20\\d{2}-?\\d{2}-?\\d{2})?$`, "i");
}
function match(rows: Price[], model: EconomicModel): Price | undefined {
  const ownHost = host(model.baseUrl), id = leaf(model.id);
  const namespace = model.id.includes("/") ? model.id.split("/")[0] : undefined;
  for (const scope of [rows.filter(row => row.provider === model.provider),
    ownHost ? rows.filter(row => row.host === ownHost) : [], rows.filter(row => row.provider === namespace), rows]) {
    const exact = scope.filter(row => leaf(row.id) === id);
    const found = exact.length ? exact : scope.filter(row => pattern(row.id).test(id));
    const first = found[0];
    if (!first) continue;
    // Conflicting gateway quotes are not a licence to pick the cheapest provider.
    return found.every(row => JSON.stringify([row.cost, row.tiers]) === JSON.stringify([first.cost, first.tiers])) ? first : undefined;
  }
}
function remotePrices(data: unknown): Price[] {
  if (!table(data)) throw new Error("Invalid models.dev catalog");
  const rows: Price[] = [];
  for (const [provider, entry] of Object.entries(data)) {
    if (!table(entry) || !table(entry.models)) continue;
    for (const [key, model] of Object.entries(entry.models)) {
      if (!table(model)) continue;
      const id = typeof model.id === "string" ? model.id : key;
      if (id.length > 512 || !/[a-z0-9]/i.test(id)) continue;
      const rates = cost(model.cost, true, true);
      if (!rates) continue;
      const tiers: NonNullable<Price["tiers"]> = [];
      if (table(model.cost) && Array.isArray(model.cost.tiers)) for (const item of model.cost.tiers) {
        if (!table(item) || !table(item.tier) || item.tier.type !== "context" || !number(item.tier.size)) continue;
        const rates = cost({ ...model.cost, ...item }, true, true);
        if (rates) tiers.push({ after: item.tier.size, cost: rates });
      }
      if (!tiers.length && table(model.cost)) {
        const legacy = model.cost.context_over_200k;
        const rates = table(legacy) ? cost({ ...model.cost, ...legacy }, true, true) : undefined;
        if (rates) tiers.push({ after: 200000, cost: rates });
      }
      rows.push({ provider, id, host: host(entry.api),
        source: "models.dev", cost: rates, ...(tiers.length ? { tiers: tiers.sort((a, b) => a.after - b.after) } : {}) });
    }
  }
  if (!rows.length) throw new Error("models.dev catalog has no usable prices");
  return rows;
}
async function download(fetcher: typeof fetch, signal: AbortSignal): Promise<Price[]> {
  const response = await fetcher("https://models.dev/api.json", { signal });
  if (!response.ok || !response.body) throw new Error(`models.dev HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("models.dev catalog exceeds 32 MiB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return remotePrices(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

/** Registry first, then a local models.dev snapshot; no filesystem or network waits in the economic hot path. */
export class ModelPricing {
  private readonly file: string;
  private readonly fetcher: typeof fetch;
  private readonly changed: () => void;
  private readonly warning: (message: string) => void;
  private native: Price[] = [];
  private readonly registered = new Map<string, EconomicModel>();
  private readonly sources: readonly string[];
  private observed?: string;
  private applied?: string;
  private attempted?: string;
  private checkedAt = 0;
  private remote: Price[] = [];
  private readonly memo = new Map<string, Price | null>();
  private loaded = false;
  private dirty = false;
  private needed = false;
  private fetchedAt = 0;
  private task?: Promise<void>;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(options: { file: string; sources?: readonly string[]; fetcher?: typeof fetch;
    changed?: () => void; warning?: (message: string) => void }) {
    this.file = options.file;
    this.sources = options.sources ?? [];
    this.fetcher = options.fetcher ?? fetch;
    this.changed = options.changed ?? (() => {});
    this.warning = options.warning ?? console.warn;
  }

  start(models: EconomicModel[]) {
    this.registered.clear();
    for (const model of models) this.registered.set(JSON.stringify([model.provider, model.id]), model);
    this.native = models.flatMap(model => { const quote = nativePrice(model); return quote ? [quote] : []; });
    this.memo.clear();
    this.dirty = true;
    this.queue();
  }

  get(model: EconomicModel | undefined, inputTokens = 0): EconomicModel | undefined {
    if (!model) return;
    // An active Agent can still hold its old Model object after a local registry refresh.
    const latest = this.registered.get(JSON.stringify([model.provider, model.id]));
    if (latest && latest !== model && JSON.stringify(latest.cost) !== JSON.stringify(model.cost)) {
      model = { ...model, cost: latest.cost, priceTiers: latest.priceTiers, pricing: cost(latest.cost) ? "pi" : undefined };
    }
    const direct = nativePrice(model);
    const key = JSON.stringify([model.provider, model.id, host(model.baseUrl)]);
    if (!direct && !this.memo.has(key)) this.memo.set(key, match(this.native, model) ?? match(this.remote, model) ?? null);
    const row = direct ?? this.memo.get(key);
    if (!row || row.source === "models.dev") {
      this.needed = true;
      this.queue();
    }
    if (row) {
      let rates = row.cost;
      for (const tier of row.tiers ?? []) if (inputTokens > tier.after) rates = tier.cost;
      return { ...model, cost: rates,
        priceTiers: row.tiers?.length ? [{ after: 0, cost: row.cost }, ...row.tiers] : undefined,
        pricing: direct && rates.input > 0 ? model.pricing : row.source };
    }
    return !this.loaded || this.needsRefresh() ? { ...model, pricing: "pending" } : model;
  }

  /** Check only at session/model/user-task boundaries, not on every tool or token event. */
  async checkSources(): Promise<boolean> {
    if (this.closed) return false;
    const failures: string[] = [];
    const key = JSON.stringify(await Promise.all(this.sources.map(async file => {
      try {
        const value = await stat(file, { bigint: true });
        return [value.mtimeNs.toString(), value.size.toString(), value.ino.toString()];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        if (!code) throw error;
        failures.push(`${basename(file)}: ${code}`);
        return ["unavailable", code];
      }
    })));
    const changed = this.applied !== undefined && this.applied !== key;
    if (key !== this.observed && failures.length && !this.closed)
      this.warning(`Metis price refresh sources unavailable: ${failures.join("; ")}`);
    this.observed = key;
    return changed;
  }

  /** Only the host that reloaded Pi can acknowledge that its registry now corresponds to the observed files. */
  acknowledgeSources() { this.applied = this.observed; }

  private needsRefresh() {
    return (this.needed || this.remote.length > 0) && (this.attempted === undefined || this.attempted !== this.observed);
  }

  private queue() {
    if (this.closed || this.task || (!this.dirty && this.loaded && !this.needsRefresh())) return;
    let failed = false;
    this.task = this.update().catch(error => {
      failed = true;
      this.dirty = false;
      if (!this.closed) this.warning(`Metis model price cache: ${String(error)}`);
    }).finally(() => {
      this.task = undefined;
      if (!this.closed) {
        this.changed();
        if (!failed && (this.dirty || this.needsRefresh())) this.queue();
      }
    });
  }

  private async mergeCache() {
    try {
      const data: unknown = JSON.parse(await readFile(this.file, "utf8"));
      if (!table(data) || data.version !== 1 || !Array.isArray(data.prices)) throw new Error("Invalid model price cache");
      const fetchedAt = number(data.fetchedAt) ? Math.min(Date.now(), data.fetchedAt) : 0;
      if (fetchedAt >= this.fetchedAt) {
        this.remote = data.prices.flatMap(row => {
          if (!table(row) || row.source !== "models.dev" || typeof row.provider !== "string" || typeof row.id !== "string") return [];
          const rates = cost(row.cost, false, true);
          if (!rates) return [];
          const tiers = Array.isArray(row.tiers) ? row.tiers.flatMap(tier => {
            if (!table(tier) || !number(tier.after)) return [];
            const rates = cost(tier.cost, false, true);
            return rates ? [{ after: tier.after, cost: rates }] : [];
          }) : [];
          return [{ provider: row.provider, id: row.id, source: "models.dev" as const, cost: rates,
            host: typeof row.host === "string" ? row.host : undefined, tiers: tiers.sort((a, b) => a.after - b.after) }];
        });
        this.fetchedAt = fetchedAt;
        this.memo.clear();
      }
      // Completion times are comparable only within the same source generation.
      if ((this.observed === undefined || data.refreshKey === this.observed)
        && number(data.checkedAt) && data.checkedAt <= Date.now() && data.checkedAt > this.checkedAt
        && typeof data.refreshKey === "string") {
        this.checkedAt = data.checkedAt;
        this.attempted = data.refreshKey;
      }
    } catch (error) {
      if (!this.closed && (error as NodeJS.ErrnoException).code !== "ENOENT") this.warning(`Metis model price cache: ${String(error)}`);
    }
  }

  private async update() {
    if (!this.loaded) {
      await this.mergeCache();
      this.loaded = true;
    }
    await this.checkSources();
    this.applied ??= this.observed;
    if (this.needsRefresh() && !this.closed) {
      const refreshKey = this.observed;
      try {
        this.remote = await download(this.fetcher, AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]));
        this.fetchedAt = Date.now();
        this.dirty = true;
      } catch (error) {
        this.dirty = true;
        if (!this.closed) this.warning(`Metis model prices unavailable; using cached prices or 1:10 estimates: ${String(error)}`);
      } finally { this.attempted = refreshKey; this.checkedAt = Date.now(); this.memo.clear(); }
    }
    if (this.dirty && !this.closed) {
      // Another Pi process may have populated the website snapshot since this instance last read it.
      await this.mergeCache();
      this.dirty = false;
      const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await mkdir(dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 1, updatedAt: Date.now(), fetchedAt: this.fetchedAt,
          checkedAt: this.checkedAt, refreshKey: this.attempted, prices: [...this.native, ...this.remote] }), { mode: 0o600 });
        if (!this.closed) await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
    }
  }

  async close() {
    this.closed = true;
    this.abort.abort();
    await this.task;
  }
}
