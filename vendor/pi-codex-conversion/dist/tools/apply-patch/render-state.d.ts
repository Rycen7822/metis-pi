import type { ExecutePatchResult } from "../../patch/types.ts";
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
export declare function isApplyPatchToolDetails(details: unknown): details is ApplyPatchToolDetails;
export declare function clearApplyPatchRenderState(): void;
export declare function setApplyPatchRenderState(toolCallId: string, patchText: string, cwd: string, status?: "pending" | "partial_failure" | "failed", failedTargets?: string[]): void;
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
