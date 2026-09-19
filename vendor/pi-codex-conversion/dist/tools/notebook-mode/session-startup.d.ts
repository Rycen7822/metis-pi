import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotebookRuntimeOptions } from "../code-mode/shared-runtime.ts";
import type { NotebookBridgeServer } from "./bridge-server.ts";
import { type NotebookCheckpointIdentity } from "./checkpoint.ts";
import { type NotebookJournal } from "./journal.ts";
import { DenoJupyterKernel } from "./jupyter-kernel.ts";
import { type ProjectStateBaseline } from "./project-state.ts";
export interface StartedNotebookSession {
    kernel: DenoJupyterKernel;
    journal: NotebookJournal;
    checkpointIdentity: NotebookCheckpointIdentity;
    baselineNames: Set<string>;
    projectBaseline: ProjectStateBaseline;
    configuredProfileLoaded: boolean;
    restoreNotice?: string | undefined;
}
export declare function startNotebookSession(options: {
    context: ExtensionContext;
    runtime: NotebookRuntimeOptions;
    bridge: NotebookBridgeServer;
    checkpointMaxBytes: number;
    onKernelFailure?: ((kernel: DenoJupyterKernel, error: Error) => void) | undefined;
    signal?: AbortSignal | undefined;
}): Promise<StartedNotebookSession>;
