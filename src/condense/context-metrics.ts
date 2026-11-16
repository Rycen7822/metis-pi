import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { branchEntryReferences } from "../session-history.ts";
import { projectBranchMessages } from "./batch-capture.ts";
import { isConversationBoundary } from "./chain-detector.ts";
import { occKey, resultTimestampOf } from "./occurrence-key.ts";
import { isProtected, type ProtectionConfig } from "./protected.ts";
import type { ContextMetricsSnapshot, PruneFrontier } from "./types.ts";

type MetricFact = {
  assistant: boolean;
  boundary: boolean;
  chars: number;
  thinkingChars: number;
  calls: { id: string; path: string | undefined }[];
  result?: { id: string; key: string; name: string };
};

const charsOf = (value: unknown): number => JSON.stringify(value).length;

function messageFact(message: any): MetricFact {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return {
    assistant: message.role === "assistant",
    boundary: isConversationBoundary(message),
    chars: charsOf(message),
    thinkingChars: message.role === "assistant"
      ? blocks.reduce((sum: number, block: any) => sum + (block.type === "thinking" ? charsOf(block) : 0), 0) : 0,
    calls: message.role === "assistant" ? blocks.filter((block: any) => block.type === "toolCall").map((block: any) => {
      const path = (block.input ?? block.arguments)?.path;
      return { id: block.id, path: typeof path === "string" ? path : undefined };
    }) : [],
    ...(message.role === "toolResult" ? { result: {
      id: message.toolCallId, key: occKey(message.toolCallId, resultTimestampOf(message.timestamp)), name: message.toolName,
    } } : {}),
  };
}

function metricsFromFacts(facts: MetricFact[], frontier: PruneFrontier | null,
  isSummarized: (key: string) => boolean, protection: ProtectionConfig): ContextMetricsSnapshot {
  let total = 0, segment = 0, largest = 0, thinking = 0, gap = 0;
  let boundary = -1, boundaryEnd = facts.length, turn = 0;
  const paths = new Map<string, string | undefined>(), excluded = new Set<string>();
  if (frontier) for (let i = 0; i < facts.length; i++) {
    if (!facts[i].assistant || turn++ !== frontier.lastAttemptedTurnIndex) continue;
    const call = facts[i].calls.findIndex(call => call.id === frontier.lastAttemptedToolCallId);
    if (call >= 0) {
      boundary = i;
      for (const item of facts[i].calls.slice(0, call + 1)) excluded.add(item.id);
      for (let j = i + 1; j < facts.length; j++) if (facts[j].assistant) { boundaryEnd = j; break; }
    }
    break; // An unmatched frontier keeps the full gap.
  }
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    if (fact.boundary) { largest = Math.max(largest, segment); segment = thinking = 0; }
    segment += fact.chars; total += fact.chars; thinking += fact.thinkingChars;
    // A duplicate ID within one message follows the same first-match rule as backward argument lookup.
    for (let j = fact.calls.length - 1; j >= 0; j--) paths.set(fact.calls[j].id, fact.calls[j].path);
    const result = fact.result;
    if (i > boundary && result && !(i < boundaryEnd && excluded.has(result.id))
      && !isSummarized(result.key) && !isProtected(result.name, { path: paths.get(result.id) }, protection)) gap += Math.round(fact.chars / 4);
  }
  return { openCycleThinkingTokens: Math.round(thinking / 4),
    largestChainSharePct: total ? Math.round(100 * Math.max(largest, segment) / total) : 0, frontierGapTokens: gap };
}

/** Immutable source facts retain numbers, call IDs and protection paths, never message bodies or scripts. */
export class ContextMetricsReader {
  private facts = new WeakMap<object, MetricFact>();

  clear() { this.facts = new WeakMap(); }

  async read(manager: ExtensionContext["sessionManager"], frontier: PruneFrontier | null,
    isSummarized: (key: string) => boolean, protection: ProtectionConfig, signal?: AbortSignal): Promise<ContextMetricsSnapshot> {
    const cache = this.facts, facts: MetricFact[] = [], leaf = manager.getLeafId();
    const reader: typeof manager & { getEntryForScan?: typeof manager.getEntry } = manager;
    const read = reader.getEntryForScan ?? reader.getEntry;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (leaf !== manager.getLeafId()) throw new Error("This extension ctx is stale: metrics branch changed");
    };
    assertCurrent();
    let slice = performance.now();
    for (const source of branchEntryReferences(manager)) {
      if (source.type === "message" || source.type === "custom_message") {
        let fact = cache.get(source);
        if (!fact) {
          const entry = read.call(reader, source.id);
          if (!entry) throw new Error(`Session entry not found: ${source.id}`);
          const [message] = projectBranchMessages([entry]);
          fact = messageFact(message);
          cache.set(source, fact);
        }
        facts.push(fact);
      }
      if (performance.now() - slice >= 8) {
        await setImmediate(undefined, { signal }); assertCurrent(); slice = performance.now();
      }
    }
    assertCurrent();
    return metricsFromFacts(facts, frontier, isSummarized, protection);
  }
}
