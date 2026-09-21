import { type ProjectStateEntry } from "./project-state-format.ts";
export declare const PROFILE_STATE_SCHEMA = 1;
export declare const PROFILE_NAME: RegExp;
export interface ProfileStateManifest {
    schema: number;
    name: string;
    deno: string;
    v8: string;
    payload: string;
    createdAt: string;
    sourceProject: string;
    entries: ProjectStateEntry[];
    skipped: Array<{
        name: string;
        reason: string;
    }>;
}
export interface ProfileStateSummary {
    name: string;
    createdAt: string;
    sourceProject: string;
    values: number;
    definitions: number;
    skipped: number;
}
export declare function profileStatePaths(name: string, agentDir: string): {
    directory: string;
    manifest: string;
    lock: string;
};
export declare function profilesDirectory(agentDir: string): string;
export declare function assertProfileName(name: string): void;
export declare function readProfileStateManifest(path: string, expectedName?: string): ProfileStateManifest | undefined;
export declare function assertSafeProfileDirectory(directory: string, agentDir: string): void;
export { readProjectStatePayload as readProfileStatePayload, hashStateBytes as hashProfileBytes } from "./project-state-format.ts";
export declare function profileSummary(manifest: ProfileStateManifest): ProfileStateSummary;
