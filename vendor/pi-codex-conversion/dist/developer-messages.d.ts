import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export type CodexDeveloperMessageDelivery = "steer" | "followUp" | "nextTurn";
export interface CodexDeveloperMessageOptions {
    deliverAs?: CodexDeveloperMessageDelivery;
    triggerTurn?: boolean;
}
export interface CodexDeveloperMessageDetails {
    protocol: 1;
    id: string;
}
export declare const CODEX_DEVELOPER_MESSAGE_TYPE = "codex-developer-message";
export interface CodexDeveloperCustomMessage {
    customType: string;
    content: string;
    display: boolean;
    /** Plain object; the namespaced developer-message key is reserved. */
    details?: object;
}
interface PreparedIdleKickoffRequest {
    protocol: 1;
    action: "claim" | "agent_start" | "agent_settled" | "session_reset";
    start?: () => void;
    outcome?: "started" | "pending" | {
        error: string;
    } | undefined;
}
export declare function sendCodexDeveloperMessage(pi: ExtensionAPI, content: string, options?: CodexDeveloperMessageOptions): void;
export declare function trySendCodexDeveloperMessage(pi: ExtensionAPI, content: string, options?: CodexDeveloperMessageOptions): boolean;
/** Preserve caller rendering and detail fields; false means nothing was sent. */
export declare function trySendCodexDeveloperCustomMessage(pi: ExtensionAPI, message: CodexDeveloperCustomMessage, options?: CodexDeveloperMessageOptions): boolean;
export declare function tryStartCodexPreparedIdleKickoff(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "ui">): boolean;
/** Claim idle preparation; callback prompts are distinct, never coalesced away. */
export declare function tryStartCodexPreparedIdlePrompt(pi: ExtensionAPI, start?: () => void): "started" | "pending" | false;
export declare function updateCodexPreparedIdleKickoff(pi: ExtensionAPI, action: Exclude<PreparedIdleKickoffRequest["action"], "claim">): void;
export declare function registerCodexDeveloperMessageBroker(pi: ExtensionAPI, isActive: () => boolean): () => void;
export declare function customDeveloperMessageMetadata(details: unknown): unknown;
export declare function isCodexDeveloperMessageDetails(value: unknown): value is CodexDeveloperMessageDetails;
export {};
