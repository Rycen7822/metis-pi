import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { type ProjectStateBaseline, type ProjectStateSummary } from "./project-state-format.ts";
import { type ProjectStatePinUpdate } from "./project-state-merge.ts";
export type { ProjectStateBaseline, ProjectStateSummary } from "./project-state-format.ts";
export declare function restoreProjectState(kernel: DenoJupyterKernel, identity: {
    project: string;
    agentDir: string;
    maxBytes: number;
    signal?: AbortSignal | undefined;
}): Promise<ProjectStateSummary>;
export declare function projectStateBindingNames(identity: {
    project: string;
    agentDir: string;
}, maxBytes: number): string[];
export declare function writeProjectState(kernel: DenoJupyterKernel, identity: {
    project: string;
    session: string;
    agentDir: string;
}, baseline: ProjectStateBaseline, baselineNames: ReadonlySet<string>, maxBytes: number, excludeNames?: ReadonlySet<string>, pins?: ProjectStatePinUpdate | undefined): Promise<ProjectStateSummary>;
export declare function promoteProjectStateBindings(kernel: DenoJupyterKernel, names: string[]): Promise<void>;
export declare function projectStateBindingSelection(kernel: DenoJupyterKernel, signal?: AbortSignal): Promise<string[]>;
export declare function syncProjectStateBindings(kernel: DenoJupyterKernel, names: string[], signal?: AbortSignal): Promise<void>;
export declare function formatProjectStateNotice(summary: ProjectStateSummary): string | undefined;
