import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
export declare function toReplayAgentMessage(entry: SessionEntry): AgentMessage | undefined;
export declare function toPiReplayAgentMessage(entry: SessionEntry): AgentMessage | undefined;
