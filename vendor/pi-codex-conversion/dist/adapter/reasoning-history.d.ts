import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry } from "@earendil-works/pi-coding-agent";
export declare function projectCodexReasoningEntry(entry: SessionEntry): SessionEntry;
/** Rehydrate bookkeeping only in model context; leave Pi's tree and stored entries intact. */
export declare function projectCodexReasoningHistory(entries: readonly SessionEntry[], messages?: readonly AgentMessage[], leafId?: string | null): AgentMessage[];
