import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ContextManagementMessageKind, type ContextWindowIdentity } from "./messages.ts";
export interface ContextRemaining {
    remainingTokens: number | undefined;
    windowId: string | undefined;
    contextWindow: number;
}
export declare class ContextWindowBudget {
    private readonly remindedWindows;
    reset(): void;
    restore(kind: ContextManagementMessageKind, windowId: string): void;
    record(ctx: ExtensionContext, identity: ContextWindowIdentity, contextTokens?: number): {
        content: string;
        kind: "reminder";
    } | undefined;
    remaining(ctx: ExtensionContext, identity: ContextWindowIdentity | undefined, contextTokens?: number): ContextRemaining;
}
