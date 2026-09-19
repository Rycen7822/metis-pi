import { CodeModeNestedRenderStore } from "./trace-render-state.js";
import type { CodeModeToolDefinition, NotebookControlRequest, NotebookControlResult, RuntimeResponse, ToolExecutionContext } from "./types.js";
export type CodeModeExecutionKind = "code" | "notebook";
export interface NotebookRuntimeOptions {
    maxHeapMiB: number;
    agentDir: string;
    profile?: string | undefined;
}
export interface CodeModeExecutionClient {
    execute(source: string, context: ToolExecutionContext, signal?: AbortSignal, tools?: CodeModeToolDefinition[]): Promise<RuntimeResponse>;
    wait(cellId: string, yieldTimeMs: number, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    terminate(cellId: string, context: ToolExecutionContext, signal?: AbortSignal): Promise<RuntimeResponse>;
    checkpoint?(): Promise<void>;
    controlNotebook?(request: NotebookControlRequest, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    shutdown(): Promise<void>;
}
export interface CodeModeToolProvider {
    getTools(ctx?: unknown): CodeModeToolDefinition[];
    documentationPath?: string | undefined;
    isActive?(ctx: unknown): boolean;
    providesRenderers?: boolean | undefined;
    richRendering?(): boolean;
    minimalOutput?(): boolean;
    executionKind?(ctx: unknown): CodeModeExecutionKind;
    notebookOptions?(ctx: unknown): NotebookRuntimeOptions;
}
export declare class SharedCodeModeRuntime {
    readonly providers: Map<object, CodeModeToolProvider>;
    readonly renderStore: CodeModeNestedRenderStore;
    private clientPromise;
    private notebookClientPromise;
    private notebookClientOptionsKey;
    private notebookClientTransition;
    private clientStartupAbort;
    private customPromptToolsSnapshot;
    private promptSectionSnapshot;
    addProvider(provider: CodeModeToolProvider): object;
    removeProvider(id: object): void;
    activeProviders(ctx?: unknown): CodeModeToolProvider[];
    collectTools(ctx?: unknown): CodeModeToolDefinition[];
    refreshPromptTools(ctx?: unknown): CodeModeToolDefinition[];
    resetPromptTools(ctx?: unknown): CodeModeToolDefinition[];
    collectPromptTools(ctx?: unknown): CodeModeToolDefinition[];
    setPromptSection(section: string): void;
    getPromptSection(): string | undefined;
    collectRenderTools(): CodeModeToolDefinition[];
    useRichRendering(): boolean;
    useMinimalOutput(): boolean;
    executionKind(ctx?: unknown): CodeModeExecutionKind;
    getClient(ctx?: unknown): Promise<CodeModeExecutionClient>;
    private getNotebookClient;
    prepare(ctx?: unknown): Promise<void> | undefined;
    checkpointNotebook(): Promise<void>;
    controlNotebook(request: NotebookControlRequest, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
    shutdownHost(): Promise<void>;
    private collectProviderTools;
}
