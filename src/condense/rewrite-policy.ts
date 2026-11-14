import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { createRangeResolver } from "./chain-range-prune.ts";
import { occKey } from "./occurrence-key.ts";
import type { CapturedBatch, ChainCompressionConfig, ChainRange } from "./types.ts";

type Prices = { input: number; cacheRead: number; cacheWrite?: number };
export type Model = { id: string; provider: string; api: string; baseUrl?: string;
  cost?: Prices & { output?: number }; pricing?: "pi" | "models.dev" | "pending" };
type RewritePolicy = Pick<ChainCompressionConfig, "minGainTokens" | "minGainFraction"> & { minimumGain?: number };
const PAYBACK_REQUESTS = 3;
const MIN_CACHE_HIT = 0.9;
const BENEFIT_FRACTION = 0.9;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const idleTools = new Set(["context_tree_query", "write_stdin", "goal", "subagents_wait_agent", "subagents_inspect_agent",
  "subagents_list_agents"]);
const knownPrices = (model: Model | undefined): Prices | undefined => {
  const price = model?.cost;
  const resolved = model?.pricing === "pi" || model?.pricing === "models.dev";
  return price && finite(price.input) && (price.input > 0 || resolved) && finite(price.cacheRead) && price.input >= price.cacheRead
    ? price : undefined;
};
const FALLBACK_PRICES: Prices = { input: 1, cacheRead: 0.1 };
const coldPenalty = (before: number, gain: number, prefix: number, price: Prices) => {
  // A provider may charge more to rebuild its cache than for ordinary uncached input.
  const write = finite(price.cacheWrite) ? price.cacheWrite : price.input;
  return Math.max(0, before - prefix - gain) * (Math.max(price.input, write) - price.cacheRead);
};

/** Unknown primary prices use relative input units, never another model's dollar receipt. */
export function summaryRequestCost(primary: Model | undefined, model: Model, inputTokens: number, maxOutputTokens: number) {
  const main = knownPrices(primary), price = model.cost;
  const inputRate = price?.input, outputRate = price?.output;
  const resolved = model.pricing === "pi" || model.pricing === "models.dev";
  const known = finite(inputRate) && (inputRate > 0 || resolved) && finite(outputRate);
  const scale = !main && known ? 1 / (inputRate || outputRate || 1) : 1;
  const input = known ? inputRate * scale : main && main.input > 0 ? main.input : FALLBACK_PRICES.input;
  const output = known ? outputRate * scale : input;
  const cacheRead = known && finite(price?.cacheRead) ? price.cacheRead * scale : input / 10;
  const cacheWrite = known && finite(price?.cacheWrite) ? price.cacheWrite * scale : input;
  return {
    cost: model.pricing === "pending" ? Infinity : inputTokens * input + maxOutputTokens * output,
    actual(usage: Usage) {
      const billed = usage.cost?.totalFromProvider === true || (known && model.pricing === undefined);
      if (main && billed && finite(usage.cost?.total)) return usage.cost.total * 1_000_000;
      if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(finite)) return Infinity;
      return usage.input * input + usage.output * output + usage.cacheRead * cacheRead + usage.cacheWrite * cacheWrite;
    },
  };
}

/** A completed useful tool round, not polling, a failed request, or a maintenance callback. */
export function isUsefulWork(message: any, results: any[]): boolean {
  if (message?.role !== "assistant" || ["error", "aborted", "length"].includes(message.stopReason)) return false;
  const calls = new Set((message.content ?? []).filter((block: any) => block.type === "toolCall").map((block: any) => block.id));
  return results.some(result => calls.has(result.toolCallId) && !result.isError && !idleTools.has(result.toolName)
    && (result.toolName !== "exec_command" || result.details?.exit_code === 0));
}

function* usefulRounds(raw: any[]) {
  let results: any[] = [];
  for (let index = raw.length - 1; index >= 0; index--) {
    const message = raw[index];
    if (message.role === "toolResult") results.push(message);
    else {
      if (message.role === "assistant" && isUsefulWork(message, results)) yield { index, message, results };
      results = [];
    }
  }
}

/** Resolve raw positions, but measure the recent tail in its effective model-facing projection. */
function recentWorkBoundary(raw: any[], visible: any[], config: ChainCompressionConfig): number {
  let boundary = raw.length;
  if (config.minWorkTurns > 0) {
    let work = 0;
    for (const round of usefulRounds(raw)) {
      boundary = round.index;
      if (++work >= config.minWorkTurns) break;
    }
    if (work < config.minWorkTurns) boundary = 0;
  }
  if (config.minRecentTokens > 0) {
    const key = (message: any) => `${message.role}:${message.timestamp}`;
    const positions = new Map<string, number>();
    raw.forEach((message, i) => positions.set(key(message), positions.has(key(message)) ? -1 : i));
    let tokens = 0;
    let found = false;
    for (let i = visible.length - 1; i >= 0; i--) {
      tokens += estimateTokens(visible[i]);
      const position = positions.get(key(visible[i]));
      if (position === undefined || position < 0) continue;
      found = true;
      boundary = Math.min(boundary, position);
      if (tokens >= config.minRecentTokens) break;
    }
    if (!found || tokens < config.minRecentTokens) boundary = 0;
  }
  return boundary;
}

export function protectBatchWorkingSet(batches: CapturedBatch[], raw: any[], visible: any[], config: ChainCompressionConfig) {
  const boundary = recentWorkBoundary(raw, visible, config);
  const older = new Set<string>();
  for (let i = 0; i < boundary; i++) {
    const message = raw[i];
    if (message.role === "toolResult") older.add(occKey(message.toolCallId, message.timestamp));
  }
  return batches.map(batch => ({ ...batch,
    toolCalls: batch.toolCalls.filter(call => older.has(occKey(call.toolCallId, call.resultTimestamp))),
  })).filter(batch => batch.toolCalls.length > 0);
}

export function protectChainWorkingSet(chains: ChainRange[], raw: any[], visible: any[], config: ChainCompressionConfig): ChainRange[] {
  const resolve = createRangeResolver(raw);
  let boundary = recentWorkBoundary(raw, visible, config);
  // Chain count is a bounded reference signal, not an unconditional second retention window.
  let referenceBudget = config.minRecentTokens > 0 ? config.minRecentTokens : Infinity;
  for (let i = chains.length - 1, kept = 0; i >= 0 && kept < config.rollingWindow; i--) {
    const range = resolve(chains[i]);
    if (!range) continue;
    let tokens = 0;
    if (Number.isFinite(referenceBudget)) {
      for (let j = range.startIndex; j <= range.endIndex && tokens <= referenceBudget; j++) tokens += estimateTokens(raw[j]);
    }
    if (tokens > referenceBudget) break;
    referenceBudget -= tokens;
    boundary = Math.min(boundary, range.startIndex);
    kept++;
  }
  return chains.filter(chain => {
    const range = resolve(chain);
    return range !== null && range.endIndex < boundary;
  });
}

export interface RewriteGain { pi: number; proxy: number }

/** One flush measures its prefix once; every published prefix must independently satisfy the aggregate payback gate. */
export function batchRewriteAdmission(budget: RewriteBudget, messages: any[], config: ChainCompressionConfig,
  model: Model | undefined, emergency: (tokens: number) => boolean) {
  const prefixes = new Map<string, number>();
  let before = 0;
  for (const message of messages) {
    if (message.role === "toolResult") prefixes.set(occKey(message.toolCallId, message.timestamp), before);
    before += estimateTokens(message);
  }
  let prefix = before, pi = 0, proxy = 0;
  const changedPrefix = (keys: Iterable<string>) => {
    let next = prefix;
    for (const key of keys) {
      const position = prefixes.get(key);
      if (position === undefined) return undefined;
      next = Math.min(next, position);
    }
    return next;
  };
  return {
    accepts(keys: Iterable<string>, gain: RewriteGain, fee = 0) {
      const next = changedPrefix(keys);
      return next !== undefined && budget.admits(before, Math.min(pi + gain.pi, proxy + gain.proxy), next,
        // The batch plan already enforces its proxy gain floor; do not compare that floor to Pi-estimated tokens.
        { ...config, minimumGain: 0 }, model, emergency(Math.max(0, before - pi)), fee);
    },
    published(keys: Iterable<string>, gain: RewriteGain) {
      const next = changedPrefix(keys);
      if (next === undefined) throw new Error("Published batch lost its original source position");
      prefix = next; pi += gain.pi; proxy += gain.proxy;
    },
    finish() {
      if (pi > 0 && proxy > 0) budget.published(before, Math.min(pi, proxy), prefix, model);
    },
  };
}

/** Shared incremental-cost estimate, not credit for the cache spending that would also occur without compression. */
export class RewriteBudget {
  private model?: string;
  private discounted = false;
  private warmRequests = 0;
  private debt = 0;
  private fees = 0;
  private unknownFees = 0;
  private generation = 0;
  private growth = 0;
  private lastGain = 0;
  private lastUsage = -Infinity;
  private lastWork = -Infinity;

  reset() {
    this.model = undefined;
    this.discounted = false;
    this.warmRequests = this.debt = this.fees = this.unknownFees = this.growth = this.lastGain = 0;
    this.lastUsage = this.lastWork = -Infinity;
    this.generation++;
  }

  private prices(model: Model | undefined): Prices {
    const identity = model && JSON.stringify([model.provider, model.id, model.api, model.baseUrl, model.cost, model.pricing]);
    if (identity !== this.model) { this.reset(); this.model = identity; }
    const price = knownPrices(model) ?? FALLBACK_PRICES;
    this.discounted = price.input > price.cacheRead;
    return price;
  }

  observe(message: any, model: Model | undefined, workTokens = 0) {
    const price = this.prices(model);
    if (!model || message?.role !== "assistant" || message.provider !== model.provider || message.model !== model.id || message.api !== model.api
      || !finite(message.timestamp)) return;
    if (workTokens > 0 && finite(workTokens)) {
      if (["error", "aborted", "length"].includes(message.stopReason) || message.timestamp <= this.lastWork) return;
      this.lastWork = message.timestamp;
      this.growth += workTokens;
      return;
    }
    if (message.timestamp <= this.lastUsage) return;
    this.lastUsage = message.timestamp;
    const usage = message.usage;
    if (["error", "aborted", "length"].includes(message.stopReason)
      || !finite(usage?.input) || !finite(usage?.cacheRead) || !finite(usage?.cacheWrite)) {
      this.warmRequests = 0;
      return;
    }
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    if (input <= 0) { this.warmRequests = 0; return; }
    this.warmRequests = usage.cacheRead / input >= MIN_CACHE_HIT ? Math.min(PAYBACK_REQUESTS, this.warmRequests + 1) : 0;
    this.debt = Math.max(0, this.debt - this.lastGain * price.cacheRead);
  }

  /** Keep the reservation when a paid request has no usage receipt; it is not evidence of a free attempt. */
  reserveFee(cost: number): (actual: number) => void {
    const generation = this.generation;
    if (finite(cost)) this.fees += cost;
    else this.unknownFees++;
    let settled = false;
    return actual => {
      if (settled || generation !== this.generation) return;
      settled = true;
      if (finite(cost)) this.fees -= cost;
      else this.unknownFees--;
      if (finite(actual)) this.fees += actual;
      else this.unknownFees++;
    };
  }

  /** Recover completed work missed by a live callback; never replay historical spending receipts. */
  observeWork(raw: any[], model: Model | undefined) {
    this.prices(model);
    const rounds = [];
    for (const round of usefulRounds(raw)) {
      if (round.message.timestamp <= this.lastWork) break;
      rounds.push(round);
    }
    for (const { message, results } of rounds.reverse()) {
      this.observe(message, model, [message, ...results].reduce((sum, item) => sum + estimateTokens(item), 0));
    }
  }

  waitingForWork(config: RewritePolicy): boolean {
    return this.debt > 0 || (this.discounted && this.warmRequests < PAYBACK_REQUESTS)
      || (this.lastGain > 0 && this.growth < Math.max(config.minGainTokens, this.lastGain / 4));
  }

  ready(before: number, gain: number, config: RewritePolicy, emergency: boolean): boolean {
    if (!finite(before) || !finite(gain) || gain <= 0) return false;
    const minimum = config.minimumGain ?? Math.max(config.minGainTokens, before * config.minGainFraction);
    return emergency || (gain >= minimum && !this.waitingForWork(config));
  }

  admits(before: number, gain: number, prefix: number, config: RewritePolicy,
    model: Model | undefined, emergency: boolean, fee = 0): boolean {
    const prices = this.prices(model);
    if (!this.ready(before, gain, config, emergency) || gain > before || !finite(prefix) || prefix > before) return false;
    if (emergency) return true;
    if (model?.pricing === "pending" || !finite(fee) || this.unknownFees > 0) return false;
    const penalty = coldPenalty(before, gain, prefix, prices);
    return penalty + this.fees + fee <= PAYBACK_REQUESTS * gain * prices.cacheRead * BENEFIT_FRACTION;
  }

  published(before: number, gain: number, prefix: number, model: Model | undefined) {
    const prices = this.prices(model);
    this.debt = this.unknownFees > 0 ? Infinity
      : coldPenalty(before, gain, prefix, prices) + this.fees;
    this.fees = this.unknownFees = this.growth = this.warmRequests = 0;
    this.lastGain = gain;
    // Late or replayed receipts cannot settle another publication or make old work spendable again.
    this.generation++;
  }
}
