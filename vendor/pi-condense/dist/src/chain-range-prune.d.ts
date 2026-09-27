import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ChainCompressionEntry } from "./types.js";
import type { DiagnosticSink } from "./diagnostics.js";
export declare function isPerBatchSummaryMessage(msg: any): boolean;
/**
 * A ref with a `resultTimestamp` is matched by exact occurrence key against
 * `droppedOccKeys` - a live turn reusing a dropped chain's bare id must not
 * suppress that live turn's summary. A ref with no `resultTimestamp` (legacy)
 * falls back to bare-id membership in `droppedBareIds`, since no occurrence
 * discriminant was ever recorded for it.
 */
export declare function perBatchSummaryOverlapsDropped(msg: any, droppedOccKeys: Set<string>, droppedBareIds: Set<string>): boolean;
export declare function withoutThinkingBlocks(msg: AssistantMessage): AssistantMessage;
export declare function buildSyntheticChainMessage(entry: ChainCompressionEntry, summary: string, blockSummaryLookup?: (blockId: string) => string | undefined, protectedOutputs?: {
    tool: string;
    text: string;
}[]): UserMessage;
/**
 * Resolves a persisted chain entry to a positional index range.
 *
 * Role-gated and unique-match-or-nothing: exactly one start anchor (user
 * message or eligible non-pruner custom, isChainAnchorCustom) at
 * startUserTimestamp, exactly one assistant at finalAssistantTimestamp, and
 * startIndex < endIndex. Otherwise null - the entry drops nothing. Fail-closed
 * is the whole point: an id-set or timestamp-window fallback is what deleted
 * live turns (doc/specs/2026-08-12-toolcall-id-collisions.md).
 */
export declare function resolveRange(entry: Pick<ChainCompressionEntry, "startUserTimestamp" | "finalAssistantTimestamp">, messages: any[]): {
    startIndex: number;
    endIndex: number;
} | null;
export declare function applyChainCompressions(messages: any[], chainEntries: ChainCompressionEntry[], summaryTextForChain: (entry: ChainCompressionEntry) => string, stripFinalThinking: boolean, blockSummaryLookup?: (blockId: string) => string | undefined, diagnostics?: DiagnosticSink): any[];
