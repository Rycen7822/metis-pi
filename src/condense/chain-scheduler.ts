import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { createRangeResolver } from "./chain-range-prune.ts";
import type { ChainCompressionConfig, ChainRange } from "./types.ts";

type Prices = { input: number; cacheRead: number };
type Model = { id: string; provider: string; api: string; baseUrl?: string; cost?: Prices };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const idleTools = new Set(["context_tree_query", "write_stdin", "goal", "subagents_wait_agent", "subagents_inspect_agent",
  "subagents_list_agents"]);

/** A completed useful tool round, not polling, a failed request, or a maintenance callback. */
export function isChainWork(message: any, results: any[]): boolean {
  if (message?.role !== "assistant" || ["error", "aborted", "length"].includes(message.stopReason)) return false;
  const calls = new Set((message.content ?? []).filter((block: any) => block.type === "toolCall").map((block: any) => block.id));
  return results.some(result => calls.has(result.toolCallId) && !result.isError && !idleTools.has(result.toolName)
    && (result.toolName !== "exec_command" || result.details?.exit_code === 0));
}

/** Resolve one raw source, but measure the recent tail in its effective model-facing projection. */
export function protectChainWorkingSet(chains: ChainRange[], raw: any[], visible: any[], config: ChainCompressionConfig): ChainRange[] {
  const resolve = createRangeResolver(raw);
  let boundary = raw.length;
  if (config.minWorkTurns > 0) {
    let work = 0;
    let results: any[] = [];
    for (let i = raw.length - 1; i >= 0; i--) {
      const message = raw[i];
      if (message.role === "toolResult") results.push(message);
      else if (message.role === "assistant") {
        if (isChainWork(message, results)) {
          boundary = i;
          if (++work >= config.minWorkTurns) break;
        }
        results = [];
      } else results = [];
    }
    // Too little work to establish an older boundary: retain the entire observed window.
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
  // Chain count is a bounded reference signal, not an unconditional second retention window.
  // Use original-span estimates so pruning the visible projection cannot enlarge the raw reference allowance.
  let referenceBudget = config.minRecentTokens > 0 ? config.minRecentTokens : Infinity;
  for (let i = chains.length - 1, kept = 0; i >= 0 && kept < config.rollingWindow; i--) {
    const range = resolve(chains[i]);
    if (!range) continue;
    let tokens = 0;
    if (Number.isFinite(referenceBudget)) {
      for (let j = range.startIndex; j <= range.endIndex && tokens <= referenceBudget; j++) tokens += estimateTokens(raw[j]);
    }
    if (tokens > referenceBudget) break; // Do not bypass a newer large task to retain older references instead.
    referenceBudget -= tokens;
    boundary = Math.min(boundary, range.startIndex);
    kept++;
  }
  return chains.filter(chain => {
    const range = resolve(chain);
    return range !== null && range.endIndex < boundary;
  });
}

/** Session-local rewrite allowance; it is tolerated extra cost, never earned savings. */
export class ChainScheduler {
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

  // Only registered prices may fund the allowance; fallback rates are for admission, never income.
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
    // Main requests are ordered. High-water marks reject replay without an ever-growing identity set.
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

  ready(before: number, gain: number, config: ChainCompressionConfig, emergency: boolean): boolean {
    if (!finite(before) || !finite(gain) || gain <= 0) return false;
    return emergency || (gain >= Math.max(config.minGainTokens, before * config.minGainFraction)
      && (this.lastGain === 0 || this.growth >= Math.max(config.minGainTokens, this.lastGain / 4)));
  }

  admits(before: number, gain: number, prefix: number, config: ChainCompressionConfig,
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
    // Keep request high-water marks: publishing must not make an earlier usage spendable again.
  }
}
