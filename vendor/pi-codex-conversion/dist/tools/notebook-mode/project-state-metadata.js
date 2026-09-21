import { join, resolve } from "node:path";
import { projectStatePaths, hasPayloadLayout, readProjectStateManifest, } from "./project-state-format.js";
export function readRetainedProjectBindings(identity, maxBytes) {
    const paths = projectStatePaths(identity.project, identity.agentDir);
    const manifest = readProjectStateManifest(paths.manifest);
    if (!manifest || manifest.project !== resolve(identity.project))
        return [];
    if (!hasPayloadLayout(manifest.entries, join(paths.directory, manifest.payload), maxBytes))
        return [];
    return manifest.entries.map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        bytes: entry.length,
        updatedAt: entry.updatedAt ?? manifest.createdAt,
        pinned: entry.pinned === true,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
    }));
}
