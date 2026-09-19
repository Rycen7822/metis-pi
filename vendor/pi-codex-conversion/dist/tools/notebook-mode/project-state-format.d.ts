export declare const PROJECT_STATE_SCHEMA = 2;
export declare const MAX_PROJECT_ENTRIES = 10000;
export declare const MAX_PROJECT_NAME_BYTES: number;
export declare const MAX_PROJECT_MANIFEST_BYTES: number;
export declare const MAX_PROJECT_DESCRIPTION_BYTES = 256;
export declare const MAX_PROJECT_USAGE_BYTES = 512;
export declare const MAX_PROJECT_USAGE_LINES = 4;
export interface ProjectStateEntry {
    name: string;
    kind: "value" | "function";
    offset: number;
    length: number;
    hash: string;
    description?: string | undefined;
    usage?: string | undefined;
    updatedAt?: string | undefined;
    pinned?: true | undefined;
}
export interface ProjectBindingMetadata {
    description?: string | undefined;
    usage?: string | undefined;
}
export interface ProjectStateManifest {
    schema: number;
    project: string;
    generation: string;
    parentGeneration?: string | undefined;
    deno: string;
    v8: string;
    payload: string;
    createdAt: string;
    sourceSession: string;
    entries: ProjectStateEntry[];
    skipped: Array<{
        name: string;
        reason: string;
    }>;
}
export interface ProjectStateCandidate {
    deno: string;
    v8: string;
    entries: Array<Omit<ProjectStateEntry, "hash">>;
    skipped: Array<{
        name: string;
        reason: string;
    }>;
}
export interface ProjectStateBaseline {
    generation: string;
    entries: Array<{
        name: string;
        hash: string;
    } & ProjectBindingMetadata>;
}
export interface ProjectStateSummary {
    baseline: ProjectStateBaseline;
    restored: ProjectStateEntry[];
    skipped: Array<{
        name: string;
        reason: string;
    }>;
    conflicts: string[];
    message?: string | undefined;
}
export interface ProjectConflictRecord {
    names: string[];
    payload?: string | undefined;
}
export declare function projectStatePaths(project: string, agentDir: string): {
    directory: string;
    manifest: string;
    lock: string;
};
export declare function readProjectStateManifest(path: string): ProjectStateManifest | undefined;
export declare function readProjectStateCandidate(manifestPath: string, payloadPath: string, maxBytes: number): ProjectStateCandidate | undefined;
export declare function readProjectStatePayload(manifest: ProjectStateManifest, path: string, maxBytes: number): Buffer | undefined;
export declare function readProjectConflictRecord(path: string): ProjectConflictRecord | undefined;
export declare function baselineFromProjectManifest(manifest: ProjectStateManifest): ProjectStateBaseline;
export declare function emptyProjectStateSummary(): ProjectStateSummary;
export declare function hashStateBytes(bytes: Uint8Array): string;
export declare function parseProjectBindingMetadata(value: Record<string, unknown>): ProjectBindingMetadata | undefined;
