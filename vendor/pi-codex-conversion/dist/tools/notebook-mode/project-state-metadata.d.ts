import { type ProjectStateEntry } from "./project-state-format.ts";
export interface RetainedProjectBinding {
    name: string;
    kind: ProjectStateEntry["kind"];
    bytes: number;
    updatedAt: string;
    pinned: boolean;
    description?: string | undefined;
    usage?: string | undefined;
}
export declare function readRetainedProjectBindings(identity: {
    project: string;
    agentDir: string;
}, maxBytes: number): RetainedProjectBinding[];
