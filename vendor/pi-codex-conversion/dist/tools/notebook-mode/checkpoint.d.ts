import { type CheckpointManifest, type NotebookCheckpointIdentity } from "./checkpoint-format.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { type ProjectStateBaseline } from "./project-state-format.ts";
export declare const NOTEBOOK_CHECKPOINT_MAX_BYTES: number;
export type { NotebookCheckpointIdentity } from "./checkpoint-format.ts";
export interface NotebookCheckpointSummary {
    restored: string[];
    skipped: Array<{
        name: string;
        reason: string;
    }>;
    message?: string | undefined;
}
export declare function resolveNotebookCheckpointMaxBytes(maxHeapMiB: number): number;
export declare function garbageCollectSupersededNotebookCheckpoints(identity: NotebookCheckpointIdentity): void;
export declare function removeNotebookCheckpoint(identity: NotebookCheckpointIdentity): void;
export declare function notebookCheckpointBindingNames(identity: NotebookCheckpointIdentity, maxBytes: number): string[];
export declare function writeNotebookCheckpoint(kernel: DenoJupyterKernel, identity: NotebookCheckpointIdentity, baselineNames: ReadonlySet<string>, maxBytes: number, projectBaseline: ProjectStateBaseline, excludeNames?: ReadonlySet<string>): Promise<CheckpointManifest>;
export declare function restoreNotebookCheckpoint(kernel: DenoJupyterKernel, identity: NotebookCheckpointIdentity, maxBytes: number, projectBaseline: ProjectStateBaseline, signal?: AbortSignal): Promise<NotebookCheckpointSummary>;
export declare function sessionCheckpointProjectExclusions(manifest: Pick<CheckpointManifest, "projectGeneration" | "projectNames">, projectBaseline: ProjectStateBaseline): Set<string>;
