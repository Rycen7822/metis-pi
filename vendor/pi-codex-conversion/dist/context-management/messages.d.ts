import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CodexDeveloperMessageDetails } from "../developer-messages.ts";
export declare const CODEX_CONTEXT_WINDOW_MESSAGE_TYPE = "codex-context-window";
export declare const CONTEXT_WINDOW_COMPACTION_SUMMARY = "[Pi Codex context-window boundary; no conversation summary was generated.]";
export declare const CONTEXT_WINDOW_COMPACTION_STRATEGY = "codex-context-window";
export declare const CONTEXT_WINDOW_REMINDER_THRESHOLD = 6144;
export declare const CONTEXT_WINDOW_MIN_RESERVE = 16384;
export type ContextManagementMessageKind = "window" | "reminder" | "fallback";
export interface ContextWindowIdentity {
    firstWindowId: string;
    currentWindowId: string;
    previousWindowId?: string | undefined;
    windowNumber: number;
}
export interface CodexContextManagementMessageDetails extends CodexDeveloperMessageDetails {
    contextManagement: {
        protocol: 1;
        kind: ContextManagementMessageKind;
        firstWindowId: string;
        currentWindowId: string;
        previousWindowId?: string | undefined;
        trimPreviousWindow?: true | undefined;
        windowNumber: number;
    };
}
export interface ContextWindowCompactionDetails {
    protocol: 1;
    strategy: typeof CONTEXT_WINDOW_COMPACTION_STRATEGY;
    windowId?: string | undefined;
}
export declare function rewriteContextWindowGuidance(content: string, astra: boolean): string;
export declare function renderContextWindowMessage(identity: ContextWindowIdentity, threadHint?: string): string;
export declare function renderContextWindowReminder(remainingTokens: number): string;
export declare function renderManualContextCheckpoint(customInstructions?: string): string;
export declare function isCodexContextManagementMessageDetails(value: unknown): value is CodexContextManagementMessageDetails;
export declare function isContextWindowBoundary(message: AgentMessage): message is Extract<AgentMessage, {
    role: "custom";
}> & {
    details: CodexContextManagementMessageDetails;
};
export declare function isContextWindowCompactionDetails(value: unknown): value is ContextWindowCompactionDetails;
export declare function sendContextWindowMessage(pi: ExtensionAPI, content: string, kind: ContextManagementMessageKind, identity: ContextWindowIdentity, options: {
    triggerTurn: boolean;
}, trimPreviousWindow?: boolean): void;
