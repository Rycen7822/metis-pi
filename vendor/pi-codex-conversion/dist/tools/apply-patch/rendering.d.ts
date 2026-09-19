export declare function formatApplyPatchSummary(patchText: string, cwd?: string): string;
export declare function formatApplyPatchCollapsedDiff(patchText: string, cwd?: string, maxPreviewLines?: number): string;
export declare function renderApplyPatchCall(patchText: string, cwd?: string): string;
export declare function formatPatchTarget(path: string, movePath: string | undefined, cwd: string): string;
