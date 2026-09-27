import type { ChainRange } from "./types.js";
/**
 * A non-pruner custom message: eligible to open a chain (while the detector is
 * idle) and to act as a resolveRange start anchor. The `context-prune-`
 * namespace prefix excludes every pruner-emitted custom message — today
 * context-prune-summary; by construction any future pruner customType.
 */
export declare function isChainAnchorCustom(msg: any): boolean;
/**
 * Walks an AgentMessage array and emits ChainRange records for each detectable chain.
 *
 * A chain is: [user message or eligible custom message] → [assistant+toolResult turns...] → [text-only assistant].
 * Synthetic chain messages (injected by chain-range-prune) are treated as passthroughs —
 * not chain starts. This is defensive; the detector normally runs pre-compression.
 *
 * NOTE: Message identity uses `timestamp` (for user / final text-only assistant) and
 * `toolCallId` sets (for middle tool-using turns). AgentMessage has no `.id` field.
 *
 * @param isProtected  Predicate over (toolName, args); matching calls are never pruned
 *                     and their outputs are relocated verbatim into compressed chains.
 */
export declare function detectChains(messages: any[], isProtected?: (toolName: string, args: unknown) => boolean): ChainRange[];
/**
 * Appends `closing` to a copy of `branchMessages` unless the array already ends with it.
 *
 * pi emits `message_end` to extensions BEFORE persisting the message to the session
 * (agent-session.js `_processAgentEvent` runs `_emitExtensionEvent` ahead of
 * `sessionManager.appendMessage`). At the agent-message flush boundary the just-closed
 * final assistant is therefore still missing from `getBranch()`; without threading it
 * in, the newest chain reads as open and the rolling window over-retains by one
 * (effective K+1 instead of K). Identity is role+timestamp (AgentMessage has no id,
 * matching the detector's own identity model), so a future pi that persists before
 * emitting keeps this a no-op.
 */
export declare function withClosingMessage(branchMessages: any[], closing: any): any[];
