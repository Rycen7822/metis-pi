import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Api, type Model } from "@earendil-works/pi-ai";
export declare const CODEX_REASONING_UPDATE_TYPE = "codex-reasoning-update";
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
export interface CodexReasoningUpdate {
    protocol: 1;
    id: string;
    lane: string;
    initialEffort: string;
    effort: string;
}
export declare function flushCodexReasoningUpdates(pi: ExtensionAPI, ctx: ExtensionContext): void;
export declare function supportsCodexReasoningUpdates(model: Model<Api> | undefined): boolean;
export declare function codexReasoningLane(model: Model<Api>): string;
export declare function readCodexReasoningUpdate(value: unknown): CodexReasoningUpdate;
export declare function codexReasoningUpdates(messages: readonly AgentMessage[], model: Model<Api>): CodexReasoningUpdate[];
/** Record the selector change, not a replacement of earlier model-visible history. */
export declare function recordCodexReasoningUpdate(pi: ExtensionAPI, ctx: ExtensionContext, messages: readonly AgentMessage[], previousLevel?: ThinkingLevel): void;
export declare function hasPendingCodexReasoningUpdate(messages: readonly AgentMessage[]): boolean;
/** Run after replay too: native checkpoints can restore an update at the tail. */
export declare function normalizeCodexConfigurationUpdates<T extends {
    input: unknown[];
    model?: string | undefined;
    [key: string]: unknown;
}>(body: T): T;
export {};
