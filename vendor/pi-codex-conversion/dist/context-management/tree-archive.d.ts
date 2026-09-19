import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { BranchSummaryEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
export declare const TREE_ARCHIVE_ENTRY_TYPE = "codex-context-tree-archive";
export interface TreeArchiveManifestData {
    protocol: 1;
    strategy: "codex-context-tree";
    windowId: string;
    boundaryEntryId: string;
    summaryEntryId: string;
    archivedLeafId: string;
    branchBaseId: string | null;
    compactionEntryId?: string;
}
export interface TreeArchive {
    manifest: TreeArchiveManifestData;
    summary: BranchSummaryEntry;
    entries: SessionEntry[];
}
export interface TreeArchiveIndex {
    archives: TreeArchive[];
    hiddenSummarySignatures: ReadonlySet<string>;
    invalidManifest: boolean;
}
export declare function createTreeArchiveManifest(windowId: string, boundaryEntryId: string, summary: BranchSummaryEntry, compactionEntryId?: string): TreeArchiveManifestData;
export declare function buildTreeArchiveIndex(allEntries: readonly SessionEntry[], activeBranch: readonly SessionEntry[]): TreeArchiveIndex;
export declare function filterTreeArchiveSummaries(messages: readonly AgentMessage[], index: TreeArchiveIndex): AgentMessage[];
export declare function hasTreeArchiveSuccessor(entries: readonly SessionEntry[], windowId: string): boolean;
