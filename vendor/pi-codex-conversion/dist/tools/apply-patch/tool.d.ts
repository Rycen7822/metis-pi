import { Type } from "typebox";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type FusionCommandRunner } from "../action-fusion.ts";
import { type ApplyPatchToolDetails } from "./render-state.ts";
declare const PLAIN_APPLY_PATCH_PARAMETERS: Type.TObject<{
    input: Type.TString;
}>;
declare const APPLY_PATCH_PARAMETERS: Type.TObject<{
    then_run: Type.TOptional<Type.TObject<{
        command: Type.TString;
        timeout: Type.TOptional<Type.TNumber>;
    }>>;
    input: Type.TString;
}>;
type ApplyPatchToolDefinition = ToolDefinition<typeof PLAIN_APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails>;
export type ApplyPatchRenderCall = NonNullable<ApplyPatchToolDefinition["renderCall"]>;
export type ApplyPatchRenderResult = NonNullable<ApplyPatchToolDefinition["renderResult"]>;
export interface ApplyPatchToolOptions {
    runThenRun?: ((ctx: ExtensionContext) => FusionCommandRunner) | undefined;
    customRustBinariesDir?: string | undefined;
    promptSnippet?: boolean | undefined;
    showDiffWhenCollapsed?: boolean | undefined;
    renderCall?: ApplyPatchRenderCall | undefined;
    renderResult?: ApplyPatchRenderResult | undefined;
}
export type { ExecutePatchResult } from "../../patch/types.ts";
export type { ApplyPatchPartialFailureDetails, ApplyPatchSuccessDetails, ApplyPatchToolDetails, } from "./render-state.ts";
export { clearApplyPatchRenderState, isApplyPatchToolDetails } from "./render-state.ts";
export declare function createApplyPatchTool(options?: ApplyPatchToolOptions): ToolDefinition<typeof APPLY_PATCH_PARAMETERS | typeof PLAIN_APPLY_PATCH_PARAMETERS, unknown>;
export declare function registerApplyPatchTool(pi: ExtensionAPI, options?: ApplyPatchToolOptions): void;
export declare function registerApplyPatchResultEvent(pi: ExtensionAPI): void;
