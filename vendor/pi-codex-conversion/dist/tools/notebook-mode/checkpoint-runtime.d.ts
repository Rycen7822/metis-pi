import { type CheckpointManifest, type NotebookCheckpointIdentity } from "./checkpoint-format.ts";
export declare function checkpointSource(options: {
    candidates: string[];
    payloadPath: string;
    manifestPath: string;
    directory: string;
    identity: NotebookCheckpointIdentity;
    projectGeneration: string;
    projectNames: string[];
    payload: string;
    previousPayload?: string | undefined;
    skippedInvalid: Array<{
        name: string;
        reason: string;
    }>;
    maxBytes: number;
}): string;
export declare function restoreSource(manifest: CheckpointManifest, payloadPath: string, excludeNames?: ReadonlySet<string>): string;
