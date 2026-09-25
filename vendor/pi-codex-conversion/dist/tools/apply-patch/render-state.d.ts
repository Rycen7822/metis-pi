import type { ExecutePatchResult } from "../../patch/types.ts";
import { type FilePreview } from "./rendering.ts";
export interface ApplyPatchRenderSnapshot {
    readonly files: readonly FilePreview[];
    readonly showDiffWhenCollapsed: boolean;
    readonly status: "pending" | "partial_failure" | "failed";
    readonly failedTargets?: readonly string[] | undefined;
}
export interface ApplyPatchSuccessDetails {
    status: "success";
    result: ExecutePatchResult;
}
export interface ApplyPatchPartialFailureDetails {
    status: "partial_failure";
    result: ExecutePatchResult;
    failedTargets?: string[] | undefined;
}
export type ApplyPatchToolDetails = ApplyPatchSuccessDetails | ApplyPatchPartialFailureDetails;
export declare function getApplyPatchRenderSnapshot(toolCallId: string): ApplyPatchRenderSnapshot | undefined;
export declare function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails;
export declare function clearApplyPatchRenderState(): void;
export declare function setApplyPatchRenderState(toolCallId: string, patchText: string, cwd: string, status?: "pending" | "partial_failure" | "failed", failedTargets?: string[], showDiffWhenCollapsed?: boolean): void;
export declare function markApplyPatchPartialFailure(toolCallId: string, failedTargets?: string[]): void;
export declare function markApplyPatchFailure(toolCallId: string, status: "partial_failure" | "failed", failedTargets?: string[]): void;
export declare function renderApplyPatchCallFromState(args: {
    input?: unknown | undefined;
}, theme: {
    fg(role: string, text: string): string;
    bold(text: string): string;
}, context?: {
    toolCallId?: string | undefined;
    cwd?: string | undefined;
    expanded?: boolean | undefined;
    argsComplete?: boolean | undefined;
    showCollapsedDiff?: boolean | undefined;
}): string;
