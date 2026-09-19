import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig, ContextManagementMode } from "./config.ts";
import type { ExecutionMode } from "./execution-mode.ts";
import type { AdapterState } from "./state.ts";
type RuntimeContext = Pick<ExtensionContext, "model">;
interface RuntimePlanBase {
    kind: "inactive" | "extras" | "normal" | "code" | "notebook";
    toolNames: string[];
    ownedToolNames: string[];
    configuredProvider: boolean;
    codexTransport: boolean;
    effectiveOpenAICodex: boolean;
    nativeCompaction: boolean;
    contextManagement: boolean;
    contextManagementMode: ContextManagementMode;
    contextManagementRemote: boolean;
    contextManagementHybrid: boolean;
    autoReasoning: boolean;
}
export interface InactiveRuntimePlan extends RuntimePlanBase {
    kind: "inactive";
    missingToolNames?: string[];
    toolNames: [];
    prompt: undefined;
    transport: undefined;
}
export interface ExtrasRuntimePlan extends RuntimePlanBase {
    kind: "extras";
    prompt: undefined;
    transport: "responses";
}
export interface NormalRuntimePlan extends RuntimePlanBase {
    kind: "normal";
    prompt: "normal";
    transport: "responses";
}
export interface CodeRuntimePlan extends RuntimePlanBase {
    kind: "code";
    prompt: "code";
    transport: "responses" | "responses-lite";
}
export interface NotebookRuntimePlan extends RuntimePlanBase {
    kind: "notebook";
    prompt: "notebook";
    transport: "responses" | "responses-lite";
}
export type CodexRuntimePlan = InactiveRuntimePlan | ExtrasRuntimePlan | NormalRuntimePlan | CodeRuntimePlan | NotebookRuntimePlan;
export declare function resolveCodexRuntimePlan(ctx: RuntimeContext, config: CodexConversionConfig, executionMode?: ExecutionMode): CodexRuntimePlan;
export declare function resolveCodexRuntimePlanForState(ctx: RuntimeContext, state: Pick<AdapterState, "config" | "executionMode" | "availableToolNames">): CodexRuntimePlan;
export declare function isAdapterRuntime(plan: CodexRuntimePlan): plan is NormalRuntimePlan | CodeRuntimePlan | NotebookRuntimePlan;
export declare function isCodeModeRuntime(plan: CodexRuntimePlan): plan is CodeRuntimePlan | NotebookRuntimePlan;
export declare const ALL_CODEX_ADAPTER_TOOL_NAMES: string[];
export {};
