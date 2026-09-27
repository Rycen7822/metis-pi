import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolCallIndexer } from "./indexer.js";
export interface TreeNode {
    id: string;
    label: string;
    children: TreeNode[];
    expanded: boolean;
    depth: number;
    isLeaf: boolean;
    /** Optional extra detail shown when expanded (e.g. result preview) */
    detail?: string;
    /** Character count of this node's content (result text for tools, summary text for summaries) */
    charCount?: number;
}
/**
 * Scans the current session branch for prune-summary entries and builds a
 * foldable tree where each summary is a parent node and its pruned tool calls
 * are children.  Tool call records are looked up via the indexer.
 *
 * Each node carries a `charCount` so the UI can show how many characters the
 * summary replaced (making it obvious whether pruning is saving space).
 */
export declare function buildPruneTree(ctx: ExtensionCommandContext, indexer: ToolCallIndexer): TreeNode[];
export declare class TreeBrowser implements Component {
    private readonly roots;
    private flatRows;
    private selectedIndex;
    private theme;
    private onDone;
    private summaryOverlay;
    constructor(roots: TreeNode[], theme: Theme, onDone: () => void);
    invalidate(): void;
    private rebuildFlatRows;
    handleInput(data: string): void;
    render(width: number): string[];
    private openSelectedSummary;
    private renderWithSummaryOverlay;
    private renderRow;
}
