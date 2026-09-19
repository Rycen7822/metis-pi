import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const NOTEBOOK_TREE_EPOCH_ENTRY = "pi-codex-conversion-notebook-tree-epoch";
export declare function appendNotebookTreeEpoch(pi: ExtensionAPI): void;
export declare function notebookSessionIdentity(ctx: ExtensionContext): string;
