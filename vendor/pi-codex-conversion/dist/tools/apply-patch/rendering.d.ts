export interface PreviewLine {
    lineNumber: number;
    marker: " " | "+" | "-";
    text: string;
}
export interface FilePreview {
    verb: "Added" | "Deleted" | "Edited";
    path: string;
    movePath?: string | undefined;
    added: number;
    removed: number;
    lines: PreviewLine[];
}
export declare function buildApplyPatchPreviews(patchText: string, cwd?: string): FilePreview[];
export declare function formatApplyPatchSummary(patchText: string, cwd?: string, files?: readonly FilePreview[]): string;
export declare function formatApplyPatchCollapsedDiff(patchText: string, cwd?: string, maxPreviewLines?: number, files?: readonly FilePreview[]): string;
export declare function renderApplyPatchCall(patchText: string, cwd?: string, files?: readonly FilePreview[]): string;
export declare function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string;
