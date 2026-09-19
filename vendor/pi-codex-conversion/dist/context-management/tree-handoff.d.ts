import type { ExtensionAPI, ExtensionContext, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
/** Keep native navigation pending while the departing agent saves its handoff. */
export declare class CodexTreeHandoff {
    private pending;
    get active(): boolean;
    reset(): void;
    preparing(prompt: string): void;
    started(ctx: ExtensionContext): void;
    settled(ctx: ExtensionContext): void;
    finishNoteWrite(action: string, path: unknown, ctx: ExtensionContext): boolean;
    prepare(pi: ExtensionAPI, event: SessionBeforeTreeEvent, ctx: ExtensionContext, mode: ContextManagementMode): Promise<{
        cancel: boolean;
        summary?: never;
    } | {
        summary: {
            summary: string;
            details: Record<string, unknown>;
        };
        cancel?: never;
    } | undefined>;
}
