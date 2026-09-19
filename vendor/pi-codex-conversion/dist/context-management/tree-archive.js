import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, isCodexContextManagementMessageDetails } from "./messages.js";
export const TREE_ARCHIVE_ENTRY_TYPE = "codex-context-tree-archive";
const TREE_ARCHIVE_PROTOCOL = 1;
const MAX_ARCHIVE_DEPTH = 50_000;
export function createTreeArchiveManifest(windowId, boundaryEntryId, summary, compactionEntryId) {
    return {
        protocol: TREE_ARCHIVE_PROTOCOL,
        strategy: "codex-context-tree",
        windowId,
        boundaryEntryId,
        summaryEntryId: summary.id,
        archivedLeafId: summary.fromId,
        branchBaseId: summary.parentId,
        ...(compactionEntryId ? { compactionEntryId } : {}),
    };
}
export function buildTreeArchiveIndex(allEntries, activeBranch) {
    const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
    const archives = [];
    const hiddenSummarySignatures = new Set();
    const seenSummaries = new Set();
    const seenWindows = new Set();
    let invalidManifest = false;
    for (const entry of activeBranch) {
        if (entry.type !== "custom" ||
            entry.customType !== TREE_ARCHIVE_ENTRY_TYPE)
            continue;
        if (!isTreeArchiveManifestData(entry.data)) {
            invalidManifest = true;
            continue;
        }
        const manifest = entry.data;
        if (seenSummaries.has(manifest.summaryEntryId) ||
            seenWindows.has(manifest.windowId)) {
            invalidManifest = true;
            continue;
        }
        const summary = byId.get(manifest.summaryEntryId);
        if (!summary ||
            summary.type !== "branch_summary" ||
            entry.parentId !== summary.id ||
            summary.fromId !== manifest.archivedLeafId ||
            summary.parentId !== manifest.branchBaseId) {
            invalidManifest = true;
            continue;
        }
        const archivedEntries = archivedPath(manifest, byId);
        if (!archivedEntries || (manifest.compactionEntryId !== undefined &&
            !archivedEntries.some((entry) => entry.id === manifest.compactionEntryId && entry.type === "compaction"))) {
            invalidManifest = true;
            continue;
        }
        seenSummaries.add(summary.id);
        seenWindows.add(manifest.windowId);
        archives.push({ manifest, summary, entries: archivedEntries });
        // A hybrid archive is not model-authoritative until its successor window commits.
        if (!manifest.compactionEntryId || hasTreeArchiveSuccessor(activeBranch, manifest.windowId))
            hiddenSummarySignatures.add(branchSummarySignature(summary));
    }
    return { archives, hiddenSummarySignatures, invalidManifest };
}
export function filterTreeArchiveSummaries(messages, index) {
    return messages.filter((message) => message.role !== "branchSummary" ||
        !index.hiddenSummarySignatures.has(branchSummaryMessageSignature(message)));
}
function archivedPath(manifest, byId) {
    const reverse = [];
    const visited = new Set();
    let currentId = manifest.archivedLeafId;
    let foundBoundary = false;
    while (currentId !== manifest.branchBaseId) {
        if (currentId === null ||
            visited.has(currentId) ||
            reverse.length >= MAX_ARCHIVE_DEPTH)
            return undefined;
        visited.add(currentId);
        const entry = byId.get(currentId);
        if (!entry)
            return undefined;
        reverse.push(entry);
        if (entry.id === manifest.boundaryEntryId)
            foundBoundary = true;
        currentId = entry.parentId;
    }
    if (!foundBoundary)
        return undefined;
    return reverse.reverse();
}
function branchSummarySignature(summary) {
    return JSON.stringify([
        summary.fromId,
        summary.summary,
        new Date(summary.timestamp).getTime(),
    ]);
}
function branchSummaryMessageSignature(message) {
    return JSON.stringify([message.fromId, message.summary, message.timestamp]);
}
function isTreeArchiveManifestData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const manifest = value;
    return manifest["protocol"] === TREE_ARCHIVE_PROTOCOL &&
        manifest["strategy"] === "codex-context-tree" &&
        nonEmptyString(manifest["windowId"]) &&
        nonEmptyString(manifest["boundaryEntryId"]) &&
        nonEmptyString(manifest["summaryEntryId"]) &&
        nonEmptyString(manifest["archivedLeafId"]) &&
        (manifest["compactionEntryId"] === undefined || nonEmptyString(manifest["compactionEntryId"])) &&
        (manifest["branchBaseId"] === null ||
            nonEmptyString(manifest["branchBaseId"]));
}
function nonEmptyString(value) {
    return typeof value === "string" && value !== "";
}
export function hasTreeArchiveSuccessor(entries, windowId) {
    return entries.some((entry) => entry.type === "custom_message" &&
        entry.customType === CODEX_CONTEXT_WINDOW_MESSAGE_TYPE &&
        isCodexContextManagementMessageDetails(entry.details) &&
        entry.details.contextManagement.kind === "window" &&
        entry.details.contextManagement.previousWindowId === windowId);
}
