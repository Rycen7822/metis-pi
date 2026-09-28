import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotebookControlResult, ToolExecutionContext } from "../code-mode/types.ts";
import {
	notebookCheckpointBindingNames,
	removeNotebookCheckpoint,
} from "./checkpoint.ts";
import { ensureNotebookDenoBinary } from "./deno-binary.ts";
import { initializeNotebookJournal } from "./journal.ts";
import { diagnoseNotebook } from "./notebook-diagnostics.ts";
import { notebookProfileBindingNames } from "./profile-state.ts";
import { projectStateBindingNames } from "./project-state.ts";
import { readRetainedProjectBindings } from "./project-state-metadata.ts";
import type { NotebookSessionRuntime } from "./session-runtime.ts";
import { notebookCheckpointIdentity } from "./session-startup.ts";

export async function diagnosticsNotebook(
	host: NotebookSessionRuntime,
	context: ToolExecutionContext,
	signal?: AbortSignal,
): Promise<NotebookControlResult> {
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

export async function resetNotebook(
	host: NotebookSessionRuntime,
	context: ToolExecutionContext,
	signal?: AbortSignal,
): Promise<NotebookControlResult> {
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

function requireExtensionContext(context: ToolExecutionContext, action: string): ExtensionContext {
	if (!context.extensionContext) throw new Error(`Notebook ${action} requires an extension session context`);
	return context.extensionContext;
}
