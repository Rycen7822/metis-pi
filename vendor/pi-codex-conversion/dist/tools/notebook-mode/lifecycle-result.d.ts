import type { NotebookMemoryUsage } from "../code-mode/types.ts";
import type { NotebookKernelStatus, NotebookReleaseResult } from "./lifecycle-runtime.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";
export declare const NOTEBOOK_DETAILS_BUDGET: number;
export interface NotebookStatusDetails extends Record<string, unknown> {
    state: "idle" | "running";
    activeCell?: string | undefined;
    userBindings?: number | undefined;
    userCells: number;
    startedAt?: string | undefined;
    memory?: NotebookKernelStatus["memory"] | NotebookMemoryUsage | undefined;
    checkpoint: Record<string, unknown>;
    query?: string | undefined;
    matches?: Array<NotebookKernelStatus["bindings"][number] & {
        bytes?: number | undefined;
        updatedAt?: string | undefined;
        pinned?: boolean | undefined;
        description?: string | undefined;
        usage?: string | undefined;
    }> | undefined;
    omittedMatches?: number | undefined;
    retainedBindings: number;
    retainedBytes: number;
    pinnedBindings: number;
    pinned: RetainedProjectBinding[];
    omittedPinned: number;
    largestUnpinned: RetainedProjectBinding[];
    omittedLargestUnpinned: number;
}
export declare function withinNameBudget(names: string[]): string[];
export declare function formatNameList(names: string[]): string;
export declare function takeDetailValues<T>(values: T[], budget: {
    remaining: number;
}): T[];
export declare function remainingDetailsBudget(base: unknown): {
    remaining: number;
};
export declare function boundedReleaseDetails(result: NotebookReleaseResult, protectedNames: string[], restarted: boolean, checkpoint: Record<string, unknown>): Record<string, unknown>;
export declare function formatStatus(details: NotebookStatusDetails): string;
export declare function formatRelease(result: NotebookReleaseResult, restarted: boolean): string;
