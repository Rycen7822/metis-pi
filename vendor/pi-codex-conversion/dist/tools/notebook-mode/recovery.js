import { notebookCheckpointBindingNames, removeNotebookCheckpoint, } from "./checkpoint.js";
import { ensureNotebookDenoBinary } from "./deno-binary.js";
import { initializeNotebookJournal } from "./journal.js";
import { diagnoseNotebook } from "./notebook-diagnostics.js";
import { notebookProfileBindingNames } from "./profile-state.js";
import { projectStateBindingNames } from "./project-state.js";
import { readRetainedProjectBindings } from "./project-state-metadata.js";
import { notebookCheckpointIdentity } from "./session-startup.js";
export async function diagnosticsNotebook(host, context, signal) {
    const extension = requireExtensionContext(context, "diagnostics");
    const identity = notebookCheckpointIdentity(extension, host.options.agentDir);
    const journal = initializeNotebookJournal(identity, host.checkpointMaxBytes);
    const deno = await ensureNotebookDenoBinary({ agentDir: host.options.agentDir }, signal);
    const runtimeBindings = new Set([
        ...projectStateBindingNames(identity, host.checkpointMaxBytes),
        ...notebookCheckpointBindingNames(identity, host.checkpointMaxBytes),
        ...(host.configuredProfileActive()
            ? notebookProfileBindingNames(host.options.profile, host.options.agentDir, host.checkpointMaxBytes)
            : []),
    ]);
    return diagnoseNotebook({ deno, cwd: identity.project, path: journal.path, runtimeBindings, runtimeHealth: host.runtimeHealthFor(extension).state, signal });
}
export async function resetNotebook(host, context, signal) {
    signal?.throwIfAborted();
    const extension = requireExtensionContext(context, "reset");
    const identity = notebookCheckpointIdentity(extension, host.options.agentDir);
    const retained = readRetainedProjectBindings(identity, host.checkpointMaxBytes);
    const pinned = retained.filter(({ pinned: isPinned }) => isPinned).length;
    const activeCell = await host.stopWithoutCheckpoint();
    removeNotebookCheckpoint(identity);
    await host.restart(extension, signal, true);
    await host.checkpoints.flush({ force: true, requireIdle: true });
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
function requireExtensionContext(context, action) {
    if (!context.extensionContext)
        throw new Error(`Notebook ${action} requires an extension session context`);
    return context.extensionContext;
}
