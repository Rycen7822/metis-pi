import { globMatcher } from "./glob.js";
import { resolveNotebookProject } from "./project-identity.js";
import { listNotebookProfiles, loadNotebookProfile, NotebookProfileRestoreError, saveNotebookProfile, } from "./profile-state.js";
const MESSAGE_BUDGET = 16 * 1024;
export class NotebookProfileController {
    host;
    constructor(host) {
        this.host = host;
    }
    list(query) {
        const storage = this.host.profileStorage();
        const matches = query === undefined ? undefined : globMatcher(query);
        const profiles = listNotebookProfiles(storage.agentDir)
            .filter(({ name }) => !matches || matches(name));
        return {
            message: formatProfiles(profiles, query),
            details: { profiles, ...(query === undefined ? {} : { query }) },
        };
    }
    async save(name, context, signal) {
        const activeCell = this.host.activeCellId();
        if (activeCell)
            throw new Error(`Cannot save a notebook profile while exec cell "${activeCell}" is running`);
        const storage = this.host.profileStorage();
        await this.host.checkpoint();
        const summary = await saveNotebookProfile({
            name,
            kernel: this.host.kernel(),
            project: resolveNotebookProject(context.cwd),
            agentDir: storage.agentDir,
            baselineNames: this.host.baselineNames(),
            maxBytes: storage.maxBytes,
            signal,
        });
        return {
            message: `Saved notebook profile ${summary.name}: ${summary.values} value(s), ${summary.definitions} definition(s), ${summary.skipped} skipped`,
            details: { ...summary },
        };
    }
    async load(name, context, signal) {
        const activeCell = this.host.activeCellId();
        if (activeCell)
            throw new Error(`Cannot load a notebook profile while exec cell "${activeCell}" is running`);
        const storage = this.host.profileStorage();
        await this.host.checkpoint();
        let loaded;
        try {
            loaded = await loadNotebookProfile({
                name,
                kernel: this.host.kernel(),
                agentDir: storage.agentDir,
                baselineNames: this.host.baselineNames(),
                maxBytes: storage.maxBytes,
                signal,
            });
        }
        catch (error) {
            if (error instanceof NotebookProfileRestoreError) {
                const extension = context.extensionContext;
                if (extension)
                    await this.host.rollback(extension);
            }
            throw error;
        }
        if (loaded.collisions.length > 0) {
            throw new Error(`Notebook profile ${name} conflicts with existing bindings: ${bound(loaded.collisions.join(", "))}. Release or rename them before loading`);
        }
        if (loaded.loaded.length > 0) {
            this.host.markChanged();
            await this.host.checkpoint();
        }
        return {
            message: `Loaded notebook profile ${name}: ${loaded.summary.values} value(s), ${loaded.summary.definitions} definition(s)`,
            details: loaded,
        };
    }
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
