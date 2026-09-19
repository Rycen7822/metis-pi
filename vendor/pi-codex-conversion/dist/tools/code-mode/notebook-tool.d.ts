import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SharedCodeModeRuntime } from "./shared-runtime.ts";
import type { NotebookControlRequest, NotebookControlResult, ProgrammaticCodeModeToolDefinition, ToolExecutionContext } from "./types.ts";
export declare const NOTEBOOK_PARAMETERS: Type.TObject<{
    action: Type.TUnsafe<string>;
    query: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    names: Type.TOptional<Type.TArray<Type.TString>>;
}>;
type NotebookToolParameters = {
    action: string;
    query?: string | undefined;
    name?: string | undefined;
    names?: string[] | undefined;
};
export declare function registerNotebookTool(pi: ExtensionAPI, runtime: SharedCodeModeRuntime): void;
export declare function createNotebookControlProxy(runtime: SharedCodeModeRuntime): ProgrammaticCodeModeToolDefinition;
export declare function executeNotebookControl(runtime: SharedCodeModeRuntime, params: NotebookToolParameters, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
export declare function executeNotebookExecControl(runtime: SharedCodeModeRuntime, params: NotebookToolParameters, context: ToolExecutionContext, signal?: AbortSignal): Promise<NotebookControlResult>;
export declare function normalizeNotebookRequest(params: NotebookToolParameters): NotebookControlRequest;
export {};
