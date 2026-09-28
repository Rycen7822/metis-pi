import { globMatcher } from "./glob.js";
import { resolveNotebookProject } from "./project-identity.js";
import { listNotebookProfiles, loadNotebookProfile, NotebookProfileRestoreError, saveNotebookProfile, } from "./profile-state.js";
const MESSAGE_BUDGET = 16 * 1024;
export function listProfiles(host, query) {
    const matches = query === undefined ? undefined : globMatcher(query);
    const profiles = listNotebookProfiles(host.options.agentDir)
        .filter(({ name }) => !matches || matches(name));
    return {
        message: formatProfiles(profiles, query),
        details: { profiles, ...(query === undefined ? {} : { query }) },
    };
}
export async function saveProfile(host, name, context, signal) {
    const activeCell = host.activeCellId();
    if (activeCell)
        throw new Error(`Cannot save a notebook profile while exec cell "${activeCell}" is running`);
    await host.checkpoint();
    const summary = await saveNotebookProfile({
        name,
        kernel: host.kernel(),
        project: resolveNotebookProject(context.cwd),
        agentDir: host.options.agentDir,
        baselineNames: host.baselineNames(),
        maxBytes: host.checkpointMaxBytes,
        signal,
    });
    return {
        message: `Saved notebook profile ${summary.name}: ${summary.values} value(s), ${summary.definitions} definition(s), ${summary.skipped} skipped`,
        details: { ...summary },
    };
}
export async function loadProfile(host, name, context, signal) {
    const activeCell = host.activeCellId();
    if (activeCell)
        throw new Error(`Cannot load a notebook profile while exec cell "${activeCell}" is running`);
    await host.checkpoint();
    let loaded;
    try {
        loaded = await loadNotebookProfile({
            name,
            kernel: host.kernel(),
            agentDir: host.options.agentDir,
            baselineNames: host.baselineNames(),
            maxBytes: host.checkpointMaxBytes,
            signal,
        });
    }
    catch (error) {
        if (error instanceof NotebookProfileRestoreError) {
            const extension = context.extensionContext;
            if (extension)
                await host.restart(extension, undefined, true);
        }
        throw error;
    }
    if (loaded.collisions.length > 0) {
        throw new Error(`Notebook profile ${name} conflicts with existing bindings: ${bound(loaded.collisions.join(", "))}. Release or rename them before loading`);
    }
    if (loaded.loaded.length > 0) {
        host.markChanged();
        await host.checkpoint();
    }
    return {
        message: `Loaded notebook profile ${name}: ${loaded.summary.values} value(s), ${loaded.summary.definitions} definition(s)`,
        details: loaded,
    };
}
function formatProfiles(profiles, query) {
    if (profiles.length === 0)
        return query === undefined ? "No notebook profiles saved" : `No notebook profiles match ${JSON.stringify(query)}`;
    return bound([
        `Notebook profiles${query === undefined ? "" : ` matching ${JSON.stringify(query)}`}:`,
        ...profiles.map((profile) => `- ${profile.name}: ${profile.values} value(s), ${profile.definitions} definition(s), saved ${profile.createdAt}`),
    ].join("\n"));
}
function bound(value) {
    const marker = "\n[Notebook profile output truncated; narrow query]";
    return value.length <= MESSAGE_BUDGET ? value : `${value.slice(0, MESSAGE_BUDGET - marker.length)}${marker}`;
}
