import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { type ProfileStateSummary } from "./profile-state-format.ts";
export declare function saveNotebookProfile(options: {
    name: string;
    kernel: DenoJupyterKernel;
    project: string;
    agentDir: string;
    baselineNames: ReadonlySet<string>;
    maxBytes: number;
    signal?: AbortSignal | undefined;
}): Promise<ProfileStateSummary>;
export declare function loadNotebookProfile(options: {
    name: string;
    kernel: DenoJupyterKernel;
    agentDir: string;
    baselineNames: ReadonlySet<string>;
    maxBytes: number;
    signal?: AbortSignal | undefined;
}): Promise<{
    summary: ProfileStateSummary;
    loaded: string[];
    collisions: string[];
}>;
export declare function listNotebookProfiles(agentDir: string): ProfileStateSummary[];
export declare function notebookProfileBindingNames(name: string | undefined, agentDir: string, maxBytes: number): string[];
export declare class NotebookProfileRestoreError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
