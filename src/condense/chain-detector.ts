import { occKey, resultTimestampOf } from "./occurrence-key.ts";
import { hasProtectedNestedResults } from "./protected.ts";
import type { ChainRange } from "./types.ts";

export function hasToolCalls(msg: any): boolean {
  return Array.isArray(msg.content) && msg.content.some((b: any) => b.type === "toolCall");
}

/** Legacy persisted ranges may start at third-party custom messages. New tasks do not. */
export function isChainAnchorCustom(msg: any): boolean {
  return msg?.role === "custom" && !String(msg.customType ?? "").startsWith("context-prune-");
}

export function isTaskBoundary(msg: any): boolean {
  if (msg?.metisDerived) return false;
  return msg?.role === "user" || msg?.role === "custom" && msg.customType === "goal-continuation"
    && typeof msg.details?.goalId === "string";
}

/** Whole visible messages, never streaming deltas, thinking or tool output. */
export function isTextCheckpoint(msg: any): boolean {
  return msg?.role === "assistant" && !msg.metisDerived && Array.isArray(msg.content)
    && msg.content.some((block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim());
}

export function isConversationBoundary(msg: any): boolean {
  return isTaskBoundary(msg) || isTextCheckpoint(msg);
}

export function isCompletedAssistant(msg: any): boolean {
  return msg?.role === "assistant" && !msg.metisDerived && !["error", "aborted", "length"].includes(msg.stopReason);
}

/** A task boundary closes a group, but only a later successful main response proves consumption. */
export function consumedToolResults(messages: any[]): Set<string> {
  const consumed = new Set<string>();
  let receipt = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isCompletedAssistant(message)) receipt = true;
    else if (receipt && message.role === "toolResult") consumed.add(occKey(message.toolCallId, resultTimestampOf(message.timestamp)));
  }
  return consumed;
}

/** Half-open semantic intervals; Native fragments can restart at their first retained text checkpoint. */
export function conversationSegments(messages: any[]) {
  const segments: { startIndex: number; endIndex: number; closed: boolean }[] = [];
  let startIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!isConversationBoundary(messages[i])) continue;
    if (startIndex >= 0) segments.push({ startIndex, endIndex: i, closed: true });
    startIndex = i;
  }
  if (startIndex >= 0) segments.push({ startIndex, endIndex: messages.length, closed: false });
  return segments;
}

/** Shared facts for new candidates and revalidation of already-committed legacy ranges. */
export function chainContents(messages: any[], isProtected: (name: string, args: unknown) => boolean = () => false) {
  const ids = new Set<string>(), keys = new Set<string>(), protectedIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type !== "toolCall" || !block.id || !block.name) continue;
        ids.add(block.id);
        if (isProtected(block.name, block.input ?? block.args ?? block.arguments)) protectedIds.add(block.id);
      }
    } else if (message.role === "toolResult" && message.toolCallId) {
      ids.add(message.toolCallId);
      keys.add(occKey(message.toolCallId, resultTimestampOf(message.timestamp)));
      if (isProtected(message.toolName, undefined) || hasProtectedNestedResults(message.details)) protectedIds.add(message.toolCallId);
    }
  }
  return { middleToolCallIds: [...ids], middleOccurrenceKeys: [...keys], protectedToolCallIds: [...protectedIds] };
}

/** Closed text groups, not token-size classes; safety and economic admission remain separate. */
export function detectChains(messages: any[], isProtected: (name: string, args: unknown) => boolean = () => false): ChainRange[] {
  const ranges: ChainRange[] = [];
  for (const segment of conversationSegments(messages)) {
    if (!segment.closed) continue;
    const start = messages[segment.startIndex], end = messages[segment.endIndex];
    const contents = chainContents(messages.slice(segment.startIndex, segment.endIndex), isProtected);
    if (!contents.middleToolCallIds.length) continue;
    ranges.push({ startUserTimestamp: start.timestamp, finalAssistantTimestamp: end.timestamp,
      checkpointBoundary: { startRole: start.role, endRole: end.role }, ...contents });
  }
  return ranges;
}

/** message_end precedes persistence; carry its complete receipt without duplicating a persisted message. */
export function withClosingMessage(branchMessages: any[], closing: any): any[] {
  if (!closing) return branchMessages;
  const last = branchMessages[branchMessages.length - 1];
  if (last && last.role === closing.role && last.timestamp === closing.timestamp) return branchMessages;
  return [...branchMessages, closing];
}
