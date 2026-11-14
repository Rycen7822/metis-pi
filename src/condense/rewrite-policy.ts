import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { createRangeResolver } from "./chain-range-prune.ts";
import { occKey } from "./occurrence-key.ts";
import type { CapturedBatch, ChainCompressionConfig, ChainRange } from "./types.ts";

type Prices = { input: number; cacheRead: number };
type Model = { id: string; provider: string; api: string; baseUrl?: string; cost?: Prices };
type RewritePolicy = Pick<ChainCompressionConfig, "minGainTokens" | "minGainFraction" | "maxCostOverhead">
  & { minimumGain?: number };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const idleTools = new Set(["context_tree_query", "write_stdin", "goal", "subagents_wait_agent", "subagents_inspect_agent",
  "subagents_list_agents"]);

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

/** One flush measures its prefix once and spends one allowance across all actually published chunks. */
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
    accepts(keys: Iterable<string>, gain: RewriteGain) {
      const next = changedPrefix(keys);
      return next !== undefined && budget.admits(before, Math.min(pi + gain.pi, proxy + gain.proxy), next,
        // The batch plan already enforces its proxy gain floor; do not compare that floor to Pi-estimated tokens.
        { ...config, minimumGain: 0 }, model, emergency(Math.max(0, before - pi)));
    },
    published(keys: Iterable<string>, gain: RewriteGain) {
      const next = changedPrefix(keys);
      if (next === undefined) throw new Error("Published batch lost its original source position");
      prefix = next; pi += gain.pi; proxy += gain.proxy;
    },
    finish() {
      if (pi > 0 && proxy > 0) budget.published(Math.min(pi, proxy));
    },
  };
}

/** One session-local allowance for ordinary batch and chain rewrites, never assumed earned savings. */
export class RewriteBudget {
  private model?: string;
  private allowance = 0;
  private growth = 0;
  private lastGain = 0;
  private lastUsage = -Infinity;
  private lastWork = -Infinity;

  reset() {
    this.model = undefined;
    this.allowance = this.growth = this.lastGain = 0;
    this.lastUsage = this.lastWork = -Infinity;
  }

  private prices(model: Model | undefined): Prices | undefined {
    const identity = model && JSON.stringify([model.provider, model.id, model.api, model.baseUrl, model.cost]);
    if (identity !== this.model) { this.reset(); this.model = identity; }
    const price = model?.cost;
    return price && finite(price.input) && price.input > 0 && finite(price.cacheRead) && price.input >= price.cacheRead
      ? price : undefined;
  }

  observe(message: any, model: Model | undefined, workTokens = 0) {
    const price = this.prices(model);
    if (!model || message?.role !== "assistant" || message.provider !== model.provider || message.model !== model.id || message.api !== model.api
      || ["error", "aborted", "length"].includes(message.stopReason) || !finite(message.timestamp)) return;
    if (workTokens > 0 && finite(workTokens)) {
      if (message.timestamp <= this.lastWork) return;
      this.lastWork = message.timestamp;
      this.growth += workTokens;
      return;
    }
    if (message.timestamp <= this.lastUsage) return;
    this.lastUsage = message.timestamp;
    const usage = message.usage;
    if (!price || !finite(usage?.cacheRead) || !finite(usage?.cost?.cacheRead)) return;
    this.allowance += Math.min(usage.cost.cacheRead * 1_000_000, usage.cacheRead * price.cacheRead);
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
    return this.lastGain > 0 && this.growth < Math.max(config.minGainTokens, this.lastGain / 4);
  }

  ready(before: number, gain: number, config: RewritePolicy, emergency: boolean): boolean {
    if (!finite(before) || !finite(gain) || gain <= 0) return false;
    const minimum = config.minimumGain ?? Math.max(config.minGainTokens, before * config.minGainFraction);
    return emergency || (gain >= minimum && !this.waitingForWork(config));
  }

  admits(before: number, gain: number, prefix: number, config: RewritePolicy,
    model: Model | undefined, emergency: boolean): boolean {
    const prices = this.prices(model) ?? { input: 1, cacheRead: 0.1 };
    if (!this.ready(before, gain, config, emergency) || !finite(prefix) || prefix > before) return false;
    if (emergency) return true;
    const penalty = Math.max(0, before - prefix - gain) * (prices.input - prices.cacheRead);
    const debit = Math.max(0, penalty - gain * prices.cacheRead);
    return debit <= this.allowance * config.maxCostOverhead;
  }

  published(gain: number) {
    this.allowance = this.growth = 0;
    this.lastGain = gain;
    // Publishing must not make an earlier usage or work round spendable again.
  }
}
