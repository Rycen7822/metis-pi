import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotebookControlRequest, NotebookControlResult, NotebookMemoryUsage, ToolExecutionContext } from "../code-mode/types.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
import type { RetainedProjectBinding } from "./project-state-metadata.ts";
import { type NotebookReleaseResult } from "./lifecycle-runtime.ts";
import type { NotebookRuntimeHealth } from "./runtime-health.ts";
interface NotebookLifecycleHost {
    prepare(context: ToolExecutionContext, signal?: AbortSignal): Promise<void>;
    diagnostics(context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    reset(context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    kernel(): DenoJupyterKernel | undefined;
    activeCellId(): string | undefined;
    stopActive(): Promise<string | undefined>;
    checkpoint(excludeNames?: ReadonlySet<string>, pins?: {
        names: readonly string[];
        pinned: boolean;
    }): Promise<void>;
    retainedBindings(): RetainedProjectBinding[];
    promoteBindings(names: string[]): Promise<() => Promise<void>>;
    markChanged(): void;
    restart(context: ExtensionContext, signal?: AbortSignal): Promise<string | undefined>;
    rollback(context: ExtensionContext): Promise<void>;
    baselineNames(): ReadonlySet<string>;
    profileStorage(): {
        agentDir: string;
        maxBytes: number;
    };
    runtimeHealth(): NotebookRuntimeHealth;
    metadata(): {
        startedAt?: number | undefined;
        userCells: number;
        memory?: NotebookMemoryUsage | undefined;
        checkpoint: Record<string, unknown>;
    };
}
export declare class NotebookLifecycleController {
    private readonly host;
    private readonly profiles;
    constructor(host: NotebookLifecycleHost);
    control(request: NotebookControlRequest, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    disposeAll(signal?: AbortSignal): Promise<NotebookReleaseResult | undefined>;
    private status;
    private checkpoint;
    private pin;
    private release;
    private prune;
    private restart;
    private userBindingNames;
}
export {};
