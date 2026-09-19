import { randomUUID } from "node:crypto";
import { ContextWindowBudget } from "./window-budget.js";
import { rewriteWindowPayload, rewriteWindowHeaders } from "./window-request.js";
import { tryStartCodexPreparedIdleKickoff } from "../developer-messages.js";
import { loadHistoryNotesThreadHint } from "./history-notes.js";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, CONTEXT_WINDOW_COMPACTION_STRATEGY, CONTEXT_WINDOW_COMPACTION_SUMMARY, isCodexContextManagementMessageDetails, isContextWindowBoundary, isContextWindowCompactionDetails, renderContextWindowMessage, renderManualContextCheckpoint, sendContextWindowMessage, } from "./messages.js";
import { buildTreeArchiveIndex, filterTreeArchiveSummaries, } from "./tree-archive.js";
export class CodexContextWindowManager {
    identity;
    budget = new ContextWindowBudget();
    rolloverPending;
    hybridCompaction;
    manualCheckpoint;
    trimPendingWindowId;
    turnNotes;
    loadThreadHint;
    beforeWindowStart;
    constructor(loadThreadHint = loadHistoryNotesThreadHint, beforeWindowStart) {
        this.loadThreadHint = loadThreadHint;
        this.beforeWindowStart = beforeWindowStart;
    }
    reset() {
        this.identity = undefined;
        this.budget.reset();
        this.rolloverPending = undefined;
        this.hybridCompaction = undefined;
        this.manualCheckpoint = undefined;
        this.trimPendingWindowId = undefined;
        this.clearTurnNotes();
    }
    clearTurnNotes() {
        this.turnNotes = undefined;
    }
    beginTurn(ctx) {
        this.turnNotes = this.identity ? {
            sessionId: ctx.sessionManager.getSessionId(),
            windowId: this.identity.currentWindowId,
            phase: "running",
            saved: false,
        } : undefined;
    }
    settleTurn(ctx) {
        const turn = this.turnNotes;
        if (!turn || !ctx.isIdle())
            return;
        const lastAssistant = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (lastAssistant?.type !== "message" || lastAssistant.message.role !== "assistant" ||
            (lastAssistant.message.stopReason !== "stop" && lastAssistant.message.stopReason !== "length")) {
            this.clearTurnNotes();
            return;
        }
        turn.phase = "settled";
    }
    trackNoteWrite(ctx) {
        const turn = this.turnNotes;
        return () => {
            // A remote write can finish after its run or window has been replaced.
            if (turn && this.turnNotes === turn && turn.phase === "running" &&
                turn.sessionId === ctx.sessionManager.getSessionId() &&
                turn.windowId === this.identity?.currentWindowId)
                turn.saved = true;
        };
    }
    currentIdentity() {
        return this.identity ? { ...this.identity } : undefined;
    }
    restore(entries) {
        this.reset();
        for (const entry of entries) {
            if (entry.type === "compaction") {
                this.recordCompaction(entry.details);
                continue;
            }
            if (entry.type !== "custom_message" ||
                entry.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE ||
                !isCodexContextManagementMessageDetails(entry.details))
                continue;
            const details = entry.details.contextManagement;
            if (details.kind === "window") {
                this.identity = identityFromDetails(entry.details);
                this.trimPendingWindowId = details.trimPreviousWindow
                    ? details.currentWindowId
                    : undefined;
            }
            this.budget.restore(details.kind, details.currentWindowId);
        }
    }
    ensureInitialized(pi, ctx, active) {
        if (!active)
            return;
        this.restore(ctx.sessionManager.getBranch());
        if (this.identity)
            return;
        const windowId = randomUUID();
        this.sendWindowMessage(pi, {
            firstWindowId: windowId,
            currentWindowId: windowId,
            windowNumber: 0,
        }, { trimPreviousWindow: false });
    }
    project(messages, mode, activeEntries = [], allEntries = activeEntries, hybridCompaction = false) {
        if (mode === "off")
            return messages.filter((message) => message.role !== "custom" ||
                message.customType !== CODEX_CONTEXT_WINDOW_MESSAGE_TYPE);
        let boundaryIndex = -1;
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            if (message.role === "custom" &&
                message.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE &&
                !isCodexContextManagementMessageDetails(message.details))
                throw new Error("Malformed persisted Codex context-window message");
            if (!isContextWindowBoundary(message))
                continue;
            boundaryIndex = index;
            this.identity = identityFromDetails(message.details);
        }
        if (mode === "tree") {
            const index = buildTreeArchiveIndex(allEntries, activeEntries);
            const projected = !hybridCompaction && (index.archives.length === 0 || index.invalidManifest) && boundaryIndex >= 0
                ? messages.slice(boundaryIndex)
                : messages;
            this.rolloverPending = undefined;
            return filterTreeArchiveSummaries(projected, index);
        }
        if (boundaryIndex < 0)
            return [...messages];
        this.rolloverPending = undefined;
        return hybridCompaction ? [...messages] : messages.slice(boundaryIndex);
    }
    scheduleHybridCompaction() {
        if (this.hybridCompaction || this.rolloverPending)
            return false;
        this.hybridCompaction = { phase: "scheduled" };
        return true;
    }
    cancelScheduledCompaction() {
        if (this.hybridCompaction?.phase === "scheduled")
            this.hybridCompaction = undefined;
    }
    finishTurn(ctx, continueWindow) {
        if (!this.hybridCompaction)
            return false;
        if (this.hybridCompaction.phase === "running")
            return true;
        const pending = this.hybridCompaction;
        pending.phase = "running";
        // Pi compaction aborts and waits for the loop; the turn hook must return first.
        ctx.compact({
            onComplete: () => {
                if (this.hybridCompaction !== pending)
                    return;
                this.hybridCompaction = undefined;
                void continueWindow().catch((error) => {
                    ctx.ui.notify(`Compaction completed, but context rollover failed: ${error instanceof Error ? error.message : String(error)}`, "error");
                });
            },
            onError: (error) => {
                if (this.hybridCompaction !== pending)
                    return;
                this.hybridCompaction = undefined;
                ctx.ui.notify(`Context rollover failed: ${error.message}`, "error");
            },
        });
        return true;
    }
    async completeHybridCompaction(pi, ctx, mode) {
        if (this.isHybridCompactionRunning())
            return;
        this.cancelScheduledCompaction();
        await this.startNewWindow(pi, ctx, {
            mode, trimPreviousWindow: false,
        });
    }
    isHybridCompactionRunning() {
        return this.hybridCompaction?.phase === "running";
    }
    async startNewWindow(pi, ctx, options) {
        if (this.rolloverPending || options.signal?.aborted)
            return false;
        const pending = {};
        this.rolloverPending = pending;
        try {
            const current = this.identity;
            const threadHint = current && options.mode
                ? await this.loadThreadHint(ctx, options.mode, options.signal)
                : undefined;
            if (this.rolloverPending !== pending || options.signal?.aborted) {
                if (this.rolloverPending === pending)
                    this.rolloverPending = undefined;
                return false;
            }
            await this.beforeWindowStart?.(ctx, options);
            if (this.rolloverPending !== pending || options.signal?.aborted) {
                if (this.rolloverPending === pending)
                    this.rolloverPending = undefined;
                return false;
            }
            const currentWindowId = randomUUID();
            const next = current
                ? {
                    firstWindowId: current.firstWindowId,
                    currentWindowId,
                    previousWindowId: current.currentWindowId,
                    windowNumber: current.windowNumber + 1,
                }
                : {
                    firstWindowId: currentWindowId,
                    currentWindowId,
                    windowNumber: 0,
                };
            this.sendWindowMessage(pi, next, options, threadHint);
            return true;
        }
        catch (error) {
            if (this.rolloverPending === pending)
                this.rolloverPending = undefined;
            throw error;
        }
    }
    recordBudget(pi, ctx, active, contextTokens) {
        if (!active || !this.identity || this.rolloverPending)
            return;
        const reminder = this.budget.record(ctx, this.identity, contextTokens);
        if (reminder)
            sendContextWindowMessage(pi, reminder.content, reminder.kind, this.identity, { triggerTurn: true });
    }
    remaining(ctx, contextTokens) {
        return this.budget.remaining(ctx, this.identity, contextTokens);
    }
    prepareCompaction(event, mode, hybridCompaction = false) {
        if (hybridCompaction)
            return event.reason === "threshold" ? { cancel: true } : undefined;
        if (event.reason === "manual") {
            if (!this.identity)
                return { cancel: true };
            this.manualCheckpoint = {
                identity: { ...this.identity },
                customInstructions: event.customInstructions,
                signal: event.signal,
            };
            return { cancel: true };
        }
        if (event.reason === "threshold") {
            if (mode === "tree")
                return { cancel: true };
            const boundary = findLatestWindowBoundaryEntry(event.branchEntries);
            if (!boundary ||
                boundary.details.contextManagement.currentWindowId !==
                    this.trimPendingWindowId)
                return { cancel: true };
        }
        return { compaction: this.createCompaction(event) };
    }
    finishManualCheckpointRequest(pi, ctx, event, active) {
        const pending = this.manualCheckpoint;
        this.manualCheckpoint = undefined;
        if (!pending || !active || event.reason !== "manual" || !event.aborted ||
            pending.signal.aborted || pending.identity.currentWindowId !== this.identity?.currentWindowId)
            return false;
        // Pi clears its manual compaction controller before session_compact_failed.
        const idle = ctx.isIdle();
        const turn = this.turnNotes;
        if (idle && !pending.customInstructions?.trim() && turn?.phase === "settled" && turn.saved &&
            turn.sessionId === ctx.sessionManager.getSessionId() &&
            turn.windowId === pending.identity.currentWindowId)
            return true;
        sendContextWindowMessage(pi, renderManualContextCheckpoint(pending.customInstructions), "reminder", pending.identity, { triggerTurn: !idle });
        if (idle && !tryStartCodexPreparedIdleKickoff(pi, ctx))
            pi.sendUserMessage("Continue.", { deliverAs: "steer" });
        return false;
    }
    recordCompaction(details) {
        if (isContextWindowCompactionDetails(details) &&
            details.windowId === this.trimPendingWindowId)
            this.trimPendingWindowId = undefined;
    }
    createCompaction(event) {
        const boundary = findLatestWindowBoundaryEntry(event.branchEntries);
        return {
            summary: CONTEXT_WINDOW_COMPACTION_SUMMARY,
            firstKeptEntryId: boundary?.id ?? event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: {
                protocol: 1,
                strategy: CONTEXT_WINDOW_COMPACTION_STRATEGY,
                ...(this.identity
                    ? { windowId: this.identity.currentWindowId }
                    : {}),
            },
        };
    }
    rewritePayload(payload, ctx) {
        return rewriteWindowPayload(payload, ctx, this.identity);
    }
    rewriteHeaders(headers, ctx) {
        rewriteWindowHeaders(headers, ctx, this.identity);
    }
    sendWindowMessage(pi, identity, options, threadHint) {
        this.identity = identity;
        this.clearTurnNotes();
        this.trimPendingWindowId = options.trimPreviousWindow
            ? identity.currentWindowId
            : undefined;
        sendContextWindowMessage(pi, renderContextWindowMessage(identity, threadHint), "window", identity, { ...options, triggerTurn: false }, options.trimPreviousWindow);
    }
}
function identityFromDetails(details) {
    const context = details.contextManagement;
    return {
        firstWindowId: context.firstWindowId,
        currentWindowId: context.currentWindowId,
        ...(context.previousWindowId
            ? { previousWindowId: context.previousWindowId }
            : {}),
        windowNumber: context.windowNumber,
    };
}
export function findLatestWindowBoundaryEntry(entries) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.type === "custom_message" &&
            entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE &&
            isCodexContextManagementMessageDetails(entry.details) &&
            entry.details.contextManagement.kind === "window")
            return entry;
    }
    return undefined;
}
