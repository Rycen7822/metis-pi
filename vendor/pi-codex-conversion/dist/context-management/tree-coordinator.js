import { contentText, } from "@earendil-works/pi-ai";
import { CodexTreeHandoff } from "./tree-handoff.js";
import { CONTEXT_NOTE_SNAPSHOT_ENTRY_TYPE, createPiSessionNotesSnapshot, } from "./local-notes.js";
import { TREE_ARCHIVE_ENTRY_TYPE, buildTreeArchiveIndex, createTreeArchiveManifest, } from "./tree-archive.js";
import { CodexContextWindowManager, findLatestWindowBoundaryEntry, } from "./window-manager.js";
import { CodexContextWindowKickoff } from "./window-kickoff.js";
const CAPTURE_COMMAND = "pi-codex-context-tree-capture";
export class CodexContextTreeCoordinator {
    handoff = new CodexTreeHandoff();
    windows;
    kickoff;
    captured;
    pending;
    navigation;
    queuedInputs = [];
    constructor(windows, kickoff) {
        this.windows = windows;
        this.kickoff = kickoff;
    }
    get archiving() { return this.navigation !== undefined; }
    get rolloverPending() { return this.pending !== undefined || this.archiving; }
    register(pi) {
        pi.registerCommand(CAPTURE_COMMAND, {
            handler: async (_args, ctx) => {
                this.captured = {
                    sessionId: ctx.sessionManager.getSessionId(),
                    ctx,
                };
            },
        });
    }
    beginSession(pi) {
        this.reset();
        pi.sendUserMessage(`/${CAPTURE_COMMAND}`, {
            expandPromptTemplates: true,
        });
    }
    reset() {
        this.handoff.reset();
        this.captured = undefined;
        this.pending = undefined;
        this.navigation = undefined;
        this.queuedInputs = [];
    }
    schedule(ctx, options) {
        if (this.pending)
            return false;
        const sessionId = ctx.sessionManager.getSessionId();
        if (!this.captured || this.captured.sessionId !== sessionId)
            throw new Error("Tree context management is not ready for this session");
        const identity = this.windows.currentIdentity();
        const branch = ctx.sessionManager.getBranch();
        const boundary = findLatestWindowBoundaryEntry(branch);
        const leaf = branch.at(-1);
        if (!identity ||
            !boundary ||
            !leaf ||
            boundary.details.contextManagement.currentWindowId !==
                identity.currentWindowId)
            throw new Error("No active context window can be archived");
        this.pending = {
            sessionId,
            boundaryEntryId: boundary.id,
            identity,
            leafIdAtRequest: leaf.id,
            ...(options?.compactionEntryId ? { compactionEntryId: options.compactionEntryId } : {}),
            ...(options?.sourceLeafId ? { sourceLeafId: options.sourceLeafId } : {}),
            triggerTurn: options?.triggerTurn ?? true,
        };
        if (!options?.compactionEntryId)
            ctx.abort();
        return true;
    }
    interceptInput(event) {
        if (!this.navigation)
            return undefined;
        this.queuedInputs.push({
            text: event.text,
            ...(event.images ? { images: [...event.images] } : {}),
        });
        return { action: "handled" };
    }
    handleSessionTree(event) {
        if (!this.navigation || event.oldLeafId !== this.navigation.oldLeafId)
            return false;
        if (event.summaryEntry)
            this.navigation.summaryEntry = event.summaryEntry;
        return true;
    }
    async settle(pi, ctx) {
        const pending = this.pending;
        if (!pending)
            return false;
        try {
            const branch = ctx.sessionManager.getBranch();
            const allEntries = ctx.sessionManager.getEntries();
            this.assertReadyToNavigate(pending, branch, ctx);
            const target = rolloverTarget(pending.boundaryEntryId, allEntries, branch);
            const oldLeaf = branch.at(-1);
            if (!target || !oldLeaf)
                throw new Error("Tree archive target is no longer available");
            const snapshot = createPiSessionNotesSnapshot(branch);
            this.navigation = {
                oldLeafId: oldLeaf.id,
                savedEditorText: ctx.ui.getEditorText(),
                targetEditorText: editorTextForEntry(target),
            };
            const result = await this.captured.ctx.navigateTree(target.id, {
                summarize: true,
            });
            if (result.cancelled)
                throw new Error("Tree archive was cancelled");
            const summary = this.navigation.summaryEntry ??
                findNavigationSummary(ctx.sessionManager.getBranch(), oldLeaf.id);
            if (!summary)
                throw new Error("Pi did not create a branch summary");
            this.restoreEditorAfterNavigation(ctx, this.navigation);
            pi.appendEntry(TREE_ARCHIVE_ENTRY_TYPE, createTreeArchiveManifest(pending.identity.currentWindowId, pending.boundaryEntryId, summary, pending.compactionEntryId));
            pi.appendEntry(CONTEXT_NOTE_SNAPSHOT_ENTRY_TYPE, snapshot);
            this.pending = undefined;
            const started = await this.kickoff.startWindow(pi, ctx, {
                triggerTurn: pending.triggerTurn,
                mode: "tree",
                trimPreviousWindow: false,
                // The outgoing branch remains readable after Pi archives it.
                sourceLeafId: pending.sourceLeafId ?? oldLeaf.id,
            });
            if (!started)
                throw new Error("A new context window could not be started");
            this.navigation = undefined;
            const queued = this.takeQueuedInputs();
            if (queued.length) {
                // One admission: concurrent sendUserMessage calls can race while Pi
                // still reports idle during asynchronous prompt preparation.
                const content = queued.flatMap((input) => inputContent(input));
                if (pending.triggerTurn)
                    this.kickoff.queueInput(content);
                else
                    this.restoreQueuedInputToEditor(ctx, queued);
            }
            return true;
        }
        catch (error) {
            const queued = this.takeQueuedInputs();
            const navigation = this.navigation;
            this.pending = undefined;
            this.navigation = undefined;
            ctx.ui.notify(`Tree context rollover failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            this.restoreQueuedInputToEditor(ctx, queued, navigation?.savedEditorText);
            return false;
        }
    }
    assertReadyToNavigate(pending, branch, ctx) {
        if (ctx.sessionManager.getSessionId() !== pending.sessionId ||
            !this.captured ||
            this.captured.sessionId !== pending.sessionId)
            throw new Error("The active session changed before rollover");
        if (!branch.some((entry) => entry.id === pending.leafIdAtRequest))
            throw new Error("The active branch changed before rollover");
        if (!branch.some((entry) => entry.id === pending.boundaryEntryId))
            throw new Error("The context-window boundary is no longer active");
        if (pending.compactionEntryId && !branch.some((entry) => entry.id === pending.compactionEntryId && entry.type === "compaction"))
            throw new Error("The completed compaction is no longer active");
    }
    restoreEditorAfterNavigation(ctx, navigation) {
        if (navigation.targetEditorText !== undefined &&
            ctx.ui.getEditorText() === navigation.targetEditorText)
            ctx.ui.setEditorText(navigation.savedEditorText);
    }
    takeQueuedInputs() {
        const queued = this.queuedInputs;
        this.queuedInputs = [];
        return queued;
    }
    restoreQueuedInputToEditor(ctx, queued, baseText = ctx.ui.getEditorText()) {
        const text = [
            baseText,
            ...queued.map((input) => input.text),
        ].filter(Boolean).join("\n\n");
        if (text)
            ctx.ui.setEditorText(text);
        if (queued.some((input) => input.images?.length))
            ctx.ui.notify("Resend the image attachments from the interrupted input", "warning");
    }
}
function rolloverTarget(boundaryEntryId, allEntries, branch) {
    const boundaryIndex = branch.findIndex((entry) => entry.id === boundaryEntryId);
    if (boundaryIndex < 0)
        return undefined;
    const index = buildTreeArchiveIndex(allEntries, branch);
    if (index.archives.length > 0 || index.invalidManifest)
        return branch[boundaryIndex];
    for (let index = 0; index < boundaryIndex; index += 1) {
        const entry = branch[index];
        if (entry &&
            ((entry.type === "message" && entry.message.role === "user") ||
                entry.type === "custom_message"))
            return entry;
    }
    return branch[boundaryIndex];
}
function editorTextForEntry(entry) {
    if (entry.type === "message" && entry.message.role === "user")
        return contentText(entry.message.content);
    if (entry.type === "custom_message")
        return contentText(entry.content);
    return undefined;
}
function findNavigationSummary(branch, oldLeafId) {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type === "branch_summary" && entry.fromId === oldLeafId)
            return entry;
    }
    return undefined;
}
function inputContent(input) {
    return [
        ...(input.text ? [{ type: "text", text: input.text }] : []),
        ...(input.images ?? []),
    ];
}
