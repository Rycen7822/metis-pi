import { notebookCheckpointBindingNames, removeNotebookCheckpoint, } from "./checkpoint.js";
import { ensureNotebookDenoBinary } from "./deno-binary.js";
import { initializeNotebookJournal } from "./journal.js";
import { diagnoseNotebook } from "./notebook-diagnostics.js";
import { resolveNotebookProject } from "./project-identity.js";
import { notebookProfileBindingNames } from "./profile-state.js";
import { projectStateBindingNames } from "./project-state.js";
import { readRetainedProjectBindings } from "./project-state-metadata.js";
import { notebookSessionIdentity } from "./session-identity.js";
export class NotebookRecoveryController {
    agentDir;
    maxBytes;
    profile;
    host;
    constructor(options, host) {
        this.agentDir = options.agentDir;
        this.maxBytes = options.maxBytes;
        this.profile = options.profile;
        this.host = host;
    }
    async diagnostics(context, signal) {
        const identity = this.identity(context, "diagnostics");
        const journal = initializeNotebookJournal(identity, this.maxBytes);
        const deno = await ensureNotebookDenoBinary({ agentDir: this.agentDir }, signal);
        const runtimeBindings = new Set([
            ...projectStateBindingNames(identity, this.maxBytes),
            ...notebookCheckpointBindingNames(identity, this.maxBytes),
            ...(this.host.configuredProfileActive()
                ? notebookProfileBindingNames(this.profile, this.agentDir, this.maxBytes)
                : []),
        ]);
        return diagnoseNotebook({ deno, cwd: identity.project, path: journal.path, runtimeBindings, runtimeHealth: this.host.runtimeHealth(requireExtensionContext(context, "diagnostics")).state, signal });
    }
    async reset(context, signal) {
        signal?.throwIfAborted();
        const extension = requireExtensionContext(context, "reset");
        const identity = notebookIdentity(extension, this.agentDir);
        const retained = readRetainedProjectBindings(identity, this.maxBytes);
        const pinned = retained.filter(({ pinned: isPinned }) => isPinned).length;
        const activeCell = await this.host.stopWithoutCheckpoint();
        removeNotebookCheckpoint(identity);
        await this.host.startClean(extension, signal);
        await this.host.checkpointEmpty();
        return {
            message: `Notebook reset to durable project state; preserved ${retained.length} project binding${retained.length === 1 ? "" : "s"}${pinned > 0 ? ` including ${pinned} pinned` : ""}${activeCell ? ` and terminated ${activeCell}` : ""}. The session checkpoint was discarded; saved notebook and named profiles were preserved`,
            details: {
                project: identity.project,
                preservedProjectBindings: retained.length,
                preservedPinnedBindings: pinned,
                discardedSessionCheckpoint: true,
                ...(activeCell ? { terminatedCell: activeCell } : {}),
            },
        };
    }
    identity(context, action) {
        return notebookIdentity(requireExtensionContext(context, action), this.agentDir);
    }
}
function notebookIdentity(context, agentDir) {
    return {
        project: resolveNotebookProject(context.cwd),
        session: notebookSessionIdentity(context),
        agentDir,
    };
}
function requireExtensionContext(context, action) {
    if (!context.extensionContext)
        throw new Error(`Notebook ${action} requires an extension session context`);
    return context.extensionContext;
}
