import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResponsesCompatibleRequestPayload } from "../compaction/compaction-runtime.ts";
import { type ResponsesInputItem, type SerializeResponsesMessagesOptions } from "../compaction/serializer.js";
import type { FreshAuthoritativePreamble } from "./payload-preamble.ts";
import type { NativeCompactionEntry } from "../compaction/types.js";
export type SerializedReplaySlice = {
    entries: SessionEntry[];
    messages: AgentMessage[];
    input: ResponsesInputItem[];
};
export type ReplayMessageSet = {
    messages: AgentMessage[];
    input: ResponsesInputItem[];
};
export type ReplayMatch = {
    originalPiReplayInput: ResponsesInputItem[];
    preCompactionKept: ReplayMessageSet;
    postCompactionTail: ReplayMessageSet;
    actualPostCompactionTail: ResponsesInputItem[];
    extraPostCompactionTail: ResponsesInputItem[];
};
export declare function collectReplayMessages(entries: readonly SessionEntry[]): AgentMessage[];
export declare function createCompactionSummaryAgentMessage(entry: NativeCompactionEntry): AgentMessage;
export declare function createReplaySlice(entries: readonly SessionEntry[], messages: readonly AgentMessage[], input: readonly ResponsesInputItem[]): SerializedReplaySlice;
export declare function buildLenientNativeReplayPayload(args: {
    payload: ResponsesCompatibleRequestPayload;
    freshPreamble: FreshAuthoritativePreamble;
    compactedWindow: readonly unknown[];
    compactionSummaryInput: readonly ResponsesInputItem[];
}): {
    input: unknown[];
    conversationInput: ResponsesInputItem[];
} | undefined;
export declare function findReplayMatch<TApi extends Api>(args: {
    model: Model<TApi>;
    payloadInput: readonly unknown[];
    freshPreamble: FreshAuthoritativePreamble;
    compactionSummaryMessage: AgentMessage;
    preCompactionEntries: readonly SessionEntry[];
    postCompactionEntries: readonly SessionEntry[];
    serializationOptions?: SerializeResponsesMessagesOptions | undefined;
}): ReplayMatch | undefined;
