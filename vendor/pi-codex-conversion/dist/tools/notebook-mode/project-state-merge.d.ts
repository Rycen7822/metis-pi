import { type ProjectStateBaseline, type ProjectStateCandidate, type ProjectStateEntry, type ProjectStateManifest } from "./project-state-format.ts";
export interface ProjectStateMerge {
    changed: boolean;
    baseline: ProjectStateBaseline;
    entries: ProjectStateEntry[];
    payload: Buffer;
    conflicts: string[];
    appliedNames: string[];
    conflictEntries: ProjectStateEntry[];
    conflictDeletions: string[];
    conflictPayload: Buffer;
}
export interface ProjectStatePinUpdate {
    names: readonly string[];
    pinned: boolean;
}
export declare function mergeProjectState(options: {
    baseline: ProjectStateBaseline;
    current?: ProjectStateManifest | undefined;
    candidate: ProjectStateCandidate;
    candidatePayload: Buffer;
    currentPayload: Buffer;
    pins?: ProjectStatePinUpdate | undefined;
}): ProjectStateMerge;
export declare function projectStateEntryFingerprint(entry: {
    hash?: string | undefined;
    description?: string | undefined;
    usage?: string | undefined;
} | undefined): string | undefined;
