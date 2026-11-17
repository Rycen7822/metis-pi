import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { Api, Model as PiModel, Usage } from "@earendil-works/pi-ai";
import { createRangeResolver } from "./chain-range-prune.ts";
import { consumedToolResults, conversationSegments } from "./chain-detector.ts";
import { occKey } from "./occurrence-key.ts";
import { unchangedPrefixTokens } from "./token-estimator.ts";
import type { CapturedBatch, ChainCompressionConfig, ChainRange } from "./types.ts";

type Prices = { input: number; cacheRead: number; cacheWrite?: number };
export type PriceTier = { after: number; cost: Prices & { output?: number } };
export type Model = { id: string; provider: string; api: string; baseUrl?: string;
  compat?: PiModel<Api>["compat"];
  cost?: Prices & { output?: number; tiers?: Array<Partial<Prices> & { inputTokensAbove: number; output?: number }> };
  priceTiers?: PriceTier[]; pricing?: "pi" | "models.dev" | "pending" };
export type RewriteContext = { tokens?: number | null; opaque?: boolean; cacheKey?: string; messages?: any[];
  appendedCacheBoundaries?: number };
type RewritePolicy = Pick<ChainCompressionConfig, "minGainTokens" | "minGainFraction"> & {
  minimumGain?: number;
  forecastRequests?: number;
};
type CacheRequest = { key: string; envelope: string; messages: any[]; tokens: number; implicit: boolean; stableHeader: boolean };
const boundedCacheLookups = (model: Model | undefined) => model?.api === "openai-responses"
  && model.compat && "supportsExplicitPromptCacheMode" in model.compat && model.compat.supportsExplicitPromptCacheMode === true;

/** Implicit Responses lookup: latest eligible ending plus 20 earlier ones. No credit for an unobserved fallback. */
function searchablePrefix(messages: any[], before: number, prefix: number, appended: number): number {
  let suffix = 0, endings = appended;
  let nextRole: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    // This carrier expands to opaque history, not a user ending we can certify locally.
    if (message.role === "compactionSummary") return 0;
    if (message.role === "bashExecution" && message.excludeFromContext) continue;
    const role = ["custom", "branchSummary", "bashExecution"].includes(message.role) ? "user" : message.role;
    if (role === "user" || role === "toolResult" && nextRole !== "toolResult") {
      if (endings++ >= 21) return 0;
      if (before - suffix <= prefix) return Math.max(0, before - suffix);
    }
    suffix += estimateTokens(message);
    nextRole = role;
  }
  return 0;
}
const WARM_REQUESTS = 3;
const DEFAULT_FORECAST_REQUESTS = 3;
const MIN_CACHE_HIT = 0.9;
const FORECAST_CACHE_HIT = 0.98;
const FORECAST_GROWTH_TOKENS = 2000;
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
function pricesAt(price: Prices, tiers: PriceTier[] | undefined, tokens: number): Prices {
  for (const tier of tiers ?? []) if (tokens > tier.after) price = tier.cost;
  return price;
}
function requestCost(tokens: number, available: number, price: Prices, missPrice = price.input): number {
  // Fresh growth cannot be cached, even when 98% of a small request would require it.
  const cached = Math.min(tokens * FORECAST_CACHE_HIT, available);
  return cached * price.cacheRead + (tokens - cached) * missPrice;
}
function inputCost(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">, price: Prices): number {
  const write = finite(price.cacheWrite) ? price.cacheWrite : price.input;
  return usage.input * price.input + usage.cacheRead * price.cacheRead + usage.cacheWrite * write;
}
function requestSavings(after: number, gain: number, previous: number, price: Prices, tiers?: PriceTier[]): number {
  return requestCost(after + gain, previous + gain, pricesAt(price, tiers, after + gain))
    - requestCost(after, previous, pricesAt(price, tiers, after));
}
function coldCost(before: number, gain: number, prefix: number, price: Prices, tiers?: PriceTier[]): number {
  const rates = pricesAt(price, tiers, before - gain);
  const write = finite(rates.cacheWrite) ? rates.cacheWrite : rates.input;
  return requestCost(before - gain, prefix, rates, Math.max(rates.input, write))
    - requestCost(before, before, pricesAt(price, tiers, before));
}
function forecastRewrite(before: number, gain: number, prefix: number, price: Prices, tiers: PriceTier[] | undefined,
  requests = DEFAULT_FORECAST_REQUESTS) {
  const after = before - gain;
  const cold = coldCost(before, gain, prefix, price, tiers);
  let savings = 0;
  for (let request = 1; request <= requests; request++) {
    savings += requestSavings(after + request * FORECAST_GROWTH_TOKENS, gain,
      after + (request - 1) * FORECAST_GROWTH_TOKENS, price, tiers);
  }
  return { cold, savings };
}
const totalInput = (visible: number, context?: RewriteContext) => Math.max(visible, finite(context?.tokens) ? context.tokens : 0);

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
  const older = new Set<string>(), consumed = consumedToolResults(raw);
  for (let i = 0; i < boundary; i++) {
    const message = raw[i];
    const key = message.role === "toolResult" ? occKey(message.toolCallId, message.timestamp) : undefined;
    if (key && consumed.has(key)) older.add(key);
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
  if (Number.isFinite(referenceBudget)) {
    // The open text group owns the same finite budget as the closed reference groups.
    const open = conversationSegments(visible).at(-1);
    if (open) for (let i = open.startIndex; i < visible.length; i++) {
      referenceBudget = Math.max(0, referenceBudget - estimateTokens(visible[i]));
      if (referenceBudget === 0) break;
    }
  }
  for (let i = chains.length - 1, kept = 0; i >= 0 && kept < config.rollingWindow; i--) {
    const range = resolve(chains[i]);
    if (!range) continue;
    let tokens = 0;
    if (Number.isFinite(referenceBudget)) {
      for (let j = range.startIndex; j < range.endIndex && tokens <= referenceBudget; j++) tokens += estimateTokens(raw[j]);
    }
    if (tokens > referenceBudget) break;
    referenceBudget -= tokens;
    boundary = Math.min(boundary, range.startIndex);
    kept++;
  }
  return chains.filter(chain => {
    const range = resolve(chain);
    return range !== null && (chain.checkpointBoundary ? range.endIndex <= boundary : range.endIndex < boundary);
  });
}

/** Size-based economic tier, independent of whether a semantic unit is a request or a text group. */
export function boundedRewritePolicy(config: ChainCompressionConfig, tokens: number) {
  if (tokens < 2048 || tokens > 65536) return undefined;
  return { minGainTokens: config.minGainTokens, minGainFraction: config.minGainFraction,
    minimumGain: Math.max(Math.min(2048, config.minGainTokens), tokens * config.minGainFraction), forecastRequests: 32 };
}

/** This is a selection boundary, not a hard context limit; the recent working set is protected separately. */
export function localRewritePrefixAllowed(before: number, prefix: number): boolean {
  return before <= 256000 || prefix >= before - 192000;
}

export interface RewriteGain { pi: number; proxy: number }

/** Aggregate or independently profitable closed chunks settle one flush in the same shared wallet. */
export function batchRewriteAdmission(budget: RewriteBudget, messages: any[], config: ChainCompressionConfig,
  model: Model | undefined, context?: RewriteContext) {
  const admissionContext = { ...context, messages };
  const outputs = new Map<string, { prefix: number; tokens: number; closed: boolean }>();
  const consumed = consumedToolResults(messages), segments = conversationSegments(messages);
  // Closed segments are contiguous before the open one; a Native orphan prefix is not a closed group.
  const closedStart = segments[0]?.startIndex ?? 0, closedEnd = segments.at(-1)?.startIndex ?? 0;
  let before = 0;
  for (const [index, message] of messages.entries()) {
    const tokens = estimateTokens(message);
    if (message.role === "toolResult") {
      const key = occKey(message.toolCallId, message.timestamp);
      outputs.set(key, { prefix: before, tokens, closed: index >= closedStart && index < closedEnd && consumed.has(key) });
    }
    before += tokens;
  }
  let prefix = before, pi = 0, proxy = 0, publications = 0;
  const costContext = (appended: number) => ({ ...admissionContext, appendedCacheBoundaries: appended });
  const selection = (keys: Iterable<string>) => {
    let localPrefix = before, tokens = 0, allClosed = true, count = 0;
    for (const key of keys) {
      const output = outputs.get(key);
      if (!output) return undefined;
      localPrefix = Math.min(localPrefix, output.prefix);
      tokens += output.tokens; allClosed &&= output.closed; count++;
    }
    return count ? { localPrefix, tokens, allClosed, prefix: Math.min(prefix, localPrefix) } : undefined;
  };
  return {
    accepts(keys: Iterable<string>, gain: RewriteGain, fee = 0) {
      const plan = selection(keys);
      if (!plan) return false;
      // Ordinary aggregate admission keeps its own proxy gain floor and three-request forecast.
      if (budget.admits(before, Math.min(pi + gain.pi, proxy + gain.proxy), plan.prefix,
        { ...config, minimumGain: 0 }, model, false, fee, costContext(publications + 1))) return true;
      const policy = plan.allClosed ? boundedRewritePolicy(config, plan.tokens) : undefined;
      return !!policy && localRewritePrefixAllowed(before, plan.localPrefix)
        && budget.admits(before, Math.min(gain.pi, gain.proxy), plan.prefix, policy, model, false, fee, costContext(publications + 1));
    },
    published(keys: Iterable<string>, gain: RewriteGain) {
      const plan = selection(keys);
      if (!plan) throw new Error("Published batch lost its original source position");
      prefix = plan.prefix; pi += gain.pi; proxy += gain.proxy; publications++;
    },
    finish() {
      if (pi > 0 && proxy > 0) budget.published(before, Math.min(pi, proxy), prefix, model, costContext(publications));
    },
  };
}

/** Shared incremental-cost estimate, not credit for the cache spending that would also occur without compression. */
export class RewriteBudget {
  private model?: string;
  private discounted = false;
  private warmRequests = 0;
  private debt = 0;
  private repayment?: { input: number; cold?: { before: number; fees: number; reserve: number } };
  private fees = 0;
  private unknownFees = 0;
  private generation = 0;
  private growth = 0;
  private lastGain = 0;
  private lastUsage = -Infinity;
  private lastWork = -Infinity;
  private request?: CacheRequest;
  private cached?: CacheRequest & { cacheRead: number };

  reset() {
    this.model = undefined;
    this.discounted = false;
    this.repayment = undefined;
    this.request = this.cached = undefined;
    this.warmRequests = this.debt = this.fees = this.unknownFees = this.growth = this.lastGain = 0;
    this.lastUsage = this.lastWork = -Infinity;
    this.generation++;
  }

  private prices(model: Model | undefined): Prices {
    const quoted = knownPrices(model), price = quoted ?? FALLBACK_PRICES;
    const identity = model && JSON.stringify([
      model.provider, model.id, model.api, model.baseUrl, model.priceTiers ?? price, quoted ? "quoted" : model.pricing,
    ]);
    if (identity !== this.model) { this.reset(); this.model = identity; }
    this.discounted = price.input > price.cacheRead;
    return price;
  }

  /** Retain only a Responses request whose visible input and cache namespace were observed together. */
  observeRequest(model: Model | undefined, key: string | undefined, payload: unknown, messages: any[] = []) {
    this.request = undefined;
    if (!key || !messages.length || !payload || typeof payload !== "object" || !("input" in payload) || !Array.isArray(payload.input)) {
      this.cached = undefined;
      return;
    }
    this.prices(model);
    const cacheOptions = "prompt_cache_options" in payload ? payload.prompt_cache_options : undefined;
    const implicit = !cacheOptions || typeof cacheOptions !== "object" || !("mode" in cacheOptions)
      || cacheOptions.mode === undefined || cacheOptions.mode === "implicit";
    // SDK context rewrites may consolidate later developer/tool updates into the leading system message.
    // A system-free message view cannot prove that resulting header unchanged, so withhold cache credit.
    let initial = true, stableHeader = true;
    for (const item of payload.input) {
      const declaration = item?.role === "developer" || item?.role === "system" || item?.type === "additional_tools";
      if (declaration && !initial) { stableHeader = false; break; }
      if (!declaration) initial = false;
    }
    const { input: _input, ...envelope } = payload;
    const encoded = JSON.stringify(envelope);
    if (this.cached?.key !== key || this.cached.envelope !== encoded) {
      this.cached = undefined;
      this.warmRequests = 0;
    }
    this.request = { key, envelope: encoded, messages: messages.slice(), implicit, stableHeader,
      tokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0) };
  }

  private cachedPrefix(before: number, prefix: number, model: Model | undefined, context?: RewriteContext): number {
    const bounded = boundedCacheLookups(model);
    if (!context?.opaque && !bounded) return prefix;
    const cached = this.cached;
    if (!cached || !cached.stableHeader || !context?.messages || cached.key !== context.cacheKey) return 0;
    // Charge changes since the observed request too, then round back to a searchable whole-message ending.
    const stable = unchangedPrefixTokens(cached.messages, context.messages);
    if (stable === 0) return 0;
    if (bounded) {
      if (!cached.implicit) return 0; // Explicit-only endpoints need proof beyond our implicit message-ending model.
      prefix = searchablePrefix(context.messages, before, Math.min(prefix, stable), context.appendedCacheBoundaries ?? 1);
      if (prefix === 0) return 0;
    }
    const available = Math.max(0, cached.cacheRead - Math.max(cached.tokens - stable, before - prefix));
    return context.opaque ? available : Math.min(prefix, available);
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
    const failed = ["error", "aborted", "length"].includes(message.stopReason);
    const input = finite(usage?.input) && finite(usage?.cacheRead) && finite(usage?.cacheWrite)
      ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
    const validInput = finite(input) && input > 0;
    this.cached = !failed && validInput && this.request ? { ...this.request, cacheRead: usage.cacheRead } : undefined;
    this.request = undefined;
    const repayment = this.repayment;
    if (repayment?.cold) {
      const cold = repayment.cold;
      repayment.cold = undefined;
      this.warmRequests = 0;
      if (!validInput) { this.debt = Math.max(this.debt, cold.reserve); return; }
      const original = input + this.lastGain;
      const baseline = requestCost(original, cold.before, pricesAt(price, model.priceTiers, original));
      // The first receipt corrects the forecast. Later warm receipts cannot stand in for a missing cold one.
      const actual = Math.max(0, cold.fees + inputCost(usage, pricesAt(price, model.priceTiers, input)) - baseline);
      this.debt = failed ? Math.max(this.debt, actual) : actual;
      repayment.input = input;
      return;
    }
    if (failed || !validInput) { this.warmRequests = 0; return; }
    const warm = usage.cacheRead / input >= MIN_CACHE_HIT;
    this.warmRequests = warm ? Math.min(WARM_REQUESTS, this.warmRequests + 1) : 0;
    if (!repayment) return;
    if (warm || !this.discounted) {
      const cost = inputCost(usage, pricesAt(price, model.priceTiers, input));
      const original = inputCost(usage, pricesAt(price, model.priceTiers, input + this.lastGain));
      const observed = original * (input + this.lastGain) / input - cost;
      const forecast = requestSavings(input, this.lastGain, repayment.input, price, model.priceTiers);
      this.debt = Math.max(0, this.debt - Math.max(0, Math.min(observed, forecast)));
    }
    repayment.input = input;
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
    return this.debt > 0 || (this.discounted && this.warmRequests < WARM_REQUESTS)
      || (this.lastGain > 0 && this.growth < Math.max(config.minGainTokens, this.lastGain / 4));
  }

  ready(before: number, gain: number, config: RewritePolicy, emergency: boolean): boolean {
    if (!finite(before) || !finite(gain) || gain <= 0) return false;
    const minimum = config.minimumGain ?? Math.max(config.minGainTokens, before * config.minGainFraction);
    return emergency || (gain >= minimum && !this.waitingForWork(config));
  }

  admits(before: number, gain: number, prefix: number, config: RewritePolicy,
    model: Model | undefined, emergency: boolean, fee = 0, context?: RewriteContext): boolean {
    const prices = this.prices(model);
    const total = totalInput(before, context);
    if (!this.ready(total, gain, config, emergency) || gain > before || !finite(prefix) || prefix > before) return false;
    if (emergency) return true;
    if (context?.opaque && (!finite(context.tokens) || context.tokens === 0)) return false;
    if (model?.pricing === "pending" || !finite(fee) || this.unknownFees > 0) return false;
    const forecast = forecastRewrite(total, gain, this.cachedPrefix(before, prefix, model, context),
      prices, model?.priceTiers, config.forecastRequests);
    return forecast.cold + this.fees + fee < forecast.savings;
  }

  published(before: number, gain: number, prefix: number, model: Model | undefined, context?: RewriteContext) {
    const prices = this.prices(model);
    const total = totalInput(before, context);
    const cold = coldCost(total, gain, this.cachedPrefix(before, prefix, model, context), prices, model?.priceTiers);
    // A profitable first request cannot repay already-spent summary fees before it happens.
    const fees = this.unknownFees > 0 ? Infinity : this.fees;
    const reserve = Math.max(0, coldCost(total, gain, 0, prices, model?.priceTiers)) + fees;
    this.debt = Math.max(0, cold) + fees;
    this.repayment = { input: total - gain, cold: { before: total, fees, reserve } };
    this.fees = this.unknownFees = this.growth = this.warmRequests = 0;
    this.lastGain = gain;
    this.request = this.cached = undefined;
    // Late or replayed receipts cannot settle another publication or make old work spendable again.
    this.generation++;
  }
}
