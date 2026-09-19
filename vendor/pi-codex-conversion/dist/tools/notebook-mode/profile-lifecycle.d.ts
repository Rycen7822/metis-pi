import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NotebookControlResult, ToolExecutionContext } from "../code-mode/types.ts";
import type { DenoJupyterKernel } from "./jupyter-kernel.ts";
interface NotebookProfileHost {
    kernel(): DenoJupyterKernel | undefined;
    activeCellId(): string | undefined;
    checkpoint(): Promise<void>;
    markChanged(): void;
    baselineNames(): ReadonlySet<string>;
    profileStorage(): {
        agentDir: string;
        maxBytes: number;
    };
    rollback(context: ExtensionContext): Promise<void>;
}
export declare class NotebookProfileController {
    private readonly host;
    constructor(host: NotebookProfileHost);
    list(query: string | undefined): NotebookControlResult;
    save(name: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    load(name: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
}
export {};
