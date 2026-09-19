import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry } from "@earendil-works/pi-coding-agent";
/** Restore the archived checkpoint's source path only in model/replay context. */
export declare function projectTreeCheckpointBranch(active: readonly SessionEntry[], all: readonly SessionEntry[]): readonly SessionEntry[];
/** Replace only persisted context displaced by the archive; retain extension edits/additions. */
export declare function projectTreeCheckpointMessages(active: readonly SessionEntry[], projected: readonly SessionEntry[], messages: readonly AgentMessage[] | undefined): readonly AgentMessage[] | undefined;
