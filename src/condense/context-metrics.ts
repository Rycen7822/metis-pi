import { conversationSegments } from "./chain-detector.ts";
import { occKey, resultTimestampOf } from "./occurrence-key.ts";
import type { ContextMetricsSnapshot, PruneFrontier } from "./types.ts";

function charsOf(msg: any): number {
  return JSON.stringify(msg).length;
}

function toolCallBlocksOf(msg: any): { id: string; input?: unknown; arguments?: unknown }[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b: any) => b.type === "toolCall");
}

function findArgsForToolCallId(branch: any[], resultIdx: number, toolCallId: string): unknown {
  for (let i = resultIdx - 1; i >= 0; i--) {
    const m = branch[i];
    if (m.role !== "assistant") continue;
    const call = toolCallBlocksOf(m).find((c) => c.id === toolCallId);
    if (call) return (call as any).input ?? (call as any).arguments;
  }
  return undefined;
}

/**
 * Pure snapshot of what the pruner cannot (yet) reclaim: thinking tokens
 * trapped in the trailing open cycle, the largest single chain's share of
 * the branch, and unsummarized toolResult tokens past the prune frontier.
 */
export function computeContextMetrics(
  branch: any[],
  frontier: PruneFrontier | null,
  isSummarized: (occurrenceKey: string) => boolean,
  isProtected: (toolName: string, args: unknown) => boolean,
  measureChars: (value: any) => number = charsOf,
): ContextMetricsSnapshot {
  if (branch.length === 0) {
    return { openCycleThinkingTokens: 0, largestChainSharePct: 0, frontierGapTokens: 0 };
  }

  const segments = conversationSegments(branch);
  const openStart = segments.at(-1)?.startIndex ?? 0;
  let thinkingChars = 0;
  for (let i = openStart; i < branch.length; i++) {
    const message = branch[i];
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) if (block.type === "thinking") thinkingChars += measureChars(block);
  }
  const openCycleThinkingTokens = Math.round(thinkingChars / 4);
  const prefixChars = [0];
  for (const message of branch) prefixChars.push(prefixChars[prefixChars.length - 1] + measureChars(message));
  const totalChars = prefixChars[prefixChars.length - 1];
  const unanchoredPrefix = prefixChars[segments[0]?.startIndex ?? branch.length];
  const largest = segments.reduce((max, segment) => Math.max(max,
    prefixChars[segment.endIndex] - prefixChars[segment.startIndex]), unanchoredPrefix);
  const largestChainSharePct = totalChars === 0 ? 0 : Math.round(100 * largest / totalChars);

  // Exclusion is positional: only toolResults belonging to the boundary turn's
  // own calls (up to and including the last-attempted call) are excluded.
  // Ids are only unique per turn (see occurrence-key.ts), so a later turn may
  // legally reuse a bare id — its result must still count toward the gap.
  let boundaryIdx = -1;
  let boundaryTurnEndIdx = branch.length;
  const boundaryExcludedIds = new Set<string>();
  if (frontier) {
    let counter = 0;
    for (let i = 0; i < branch.length; i++) {
      const m = branch[i];
      if (m.role !== "assistant") continue;
      const turnIdx = counter;
      counter++;
      if (turnIdx === frontier.lastAttemptedTurnIndex) {
        const calls = toolCallBlocksOf(m);
        const k = calls.findIndex((c) => c.id === frontier.lastAttemptedToolCallId);
        if (k !== -1) {
          boundaryIdx = i;
          for (let j = 0; j <= k; j++) boundaryExcludedIds.add(calls[j].id);
          for (let j = i + 1; j < branch.length; j++) {
            if (branch[j].role === "assistant") {
              boundaryTurnEndIdx = j;
              break;
            }
          }
        }
        break;
      }
    }
  }

  let frontierGapTokens = 0;
  const scanStart = boundaryIdx === -1 ? 0 : boundaryIdx + 1;
  for (let i = scanStart; i < branch.length; i++) {
    const m = branch[i];
    if (m.role !== "toolResult") continue;
    if (i < boundaryTurnEndIdx && boundaryExcludedIds.has(m.toolCallId)) continue;
    const key = occKey(m.toolCallId, resultTimestampOf(m.timestamp));
    if (isSummarized(key)) continue;
    const args = findArgsForToolCallId(branch, i, m.toolCallId);
    if (isProtected(m.toolName, args)) continue;
    frontierGapTokens += Math.round((prefixChars[i + 1] - prefixChars[i]) / 4);
  }

  return { openCycleThinkingTokens, largestChainSharePct, frontierGapTokens };
}
