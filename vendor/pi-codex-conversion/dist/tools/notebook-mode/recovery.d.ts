import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotebookControlResult, ToolExecutionContext } from "../code-mode/types.ts";
import type { NotebookRuntimeHealth } from "./runtime-health.ts";
interface NotebookRecoveryHost {
    stopWithoutCheckpoint(): Promise<string | undefined>;
    startClean(context: ExtensionContext, signal?: AbortSignal): Promise<void>;
    checkpointEmpty(): Promise<void>;
    configuredProfileActive(): boolean;
    runtimeHealth(context: ExtensionContext): NotebookRuntimeHealth;
}
export declare class NotebookRecoveryController {
    private readonly agentDir;
    private readonly maxBytes;
    private readonly profile;
    private readonly host;
    constructor(options: {
        agentDir: string;
        maxBytes: number;
        profile?: string | undefined;
    }, host: NotebookRecoveryHost);
    diagnostics(context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    reset(context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    private identity;
}
export {};
