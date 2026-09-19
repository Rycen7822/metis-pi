import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { type ContextRemaining } from "./window-budget.ts";
import type { CompactionResult, ExtensionAPI, ExtensionContext, ExtensionEvent, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextManagementMode } from "../adapter/activation/config.ts";
import { type CodexContextManagementMessageDetails, type ContextWindowCompactionDetails, type ContextWindowIdentity } from "./messages.ts";
export interface StartContextWindowOptions {
    signal?: AbortSignal | undefined;
    mode?: ContextManagementMode | undefined;
    trimPreviousWindow: boolean;
    sourceLeafId?: string | undefined;
}
type ThreadHintLoader = (ctx: ExtensionContext, mode: ContextManagementMode, signal?: AbortSignal) => Promise<string | undefined>;
export declare class CodexContextWindowManager {
    private identity;
    private readonly budget;
    private rolloverPending;
    private hybridCompaction;
    private manualCheckpoint;
    private trimPendingWindowId;
    private turnNotes;
    private readonly loadThreadHint;
    private readonly beforeWindowStart;
    constructor(loadThreadHint?: ThreadHintLoader, beforeWindowStart?: (ctx: ExtensionContext, options: Pick<StartContextWindowOptions, "sourceLeafId" | "signal">) => Promise<void>);
    reset(): void;
    clearTurnNotes(): void;
    beginTurn(ctx: ExtensionContext): void;
    settleTurn(ctx: ExtensionContext): void;
    trackNoteWrite(ctx: ExtensionContext): () => void;
    currentIdentity(): ContextWindowIdentity | undefined;
    restore(entries: readonly SessionEntry[]): void;
    ensureInitialized(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean): void;
    project(messages: readonly AgentMessage[], mode: ContextManagementMode, activeEntries?: readonly SessionEntry[], allEntries?: readonly SessionEntry[], hybridCompaction?: boolean): AgentMessage[];
    scheduleHybridCompaction(): boolean;
    cancelScheduledCompaction(): void;
    finishTurn(ctx: ExtensionContext, continueWindow: () => Promise<unknown>): boolean;
    completeHybridCompaction(pi: ExtensionAPI, ctx: ExtensionContext, mode: ContextManagementMode): Promise<void>;
    isHybridCompactionRunning(): boolean;
    startNewWindow(pi: ExtensionAPI, ctx: ExtensionContext, options: StartContextWindowOptions): Promise<boolean>;
    recordBudget(pi: ExtensionAPI, ctx: ExtensionContext, active: boolean, contextTokens?: number): void;
    remaining(ctx: ExtensionContext, contextTokens?: number): ContextRemaining;
    prepareCompaction(event: SessionBeforeCompactEvent, mode: ContextManagementMode, hybridCompaction?: boolean): {
        cancel: true;
    } | {
        compaction: CompactionResult<ContextWindowCompactionDetails>;
    } | undefined;
    finishManualCheckpointRequest(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "isIdle" | "ui" | "sessionManager">, event: Extract<ExtensionEvent, {
        type: "session_compact_failed";
    }>, active: boolean): boolean;
    recordCompaction(details: unknown): void;
    createCompaction(event: SessionBeforeCompactEvent): CompactionResult<ContextWindowCompactionDetails>;
    rewritePayload(payload: unknown, ctx: ExtensionContext): unknown;
    rewriteHeaders(headers: ProviderHeaders, ctx: ExtensionContext): void;
    private sendWindowMessage;
}
export declare function findLatestWindowBoundaryEntry(entries: readonly SessionEntry[]): (Extract<SessionEntry, {
    type: "custom_message";
}> & {
    details: CodexContextManagementMessageDetails;
}) | undefined;
export {};
