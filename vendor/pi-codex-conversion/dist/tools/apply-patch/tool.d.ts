import { Type } from "typebox";
import { type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type ApplyPatchToolDetails } from "./render-state.ts";
declare const APPLY_PATCH_PARAMETERS: Type.TObject<{
    input: Type.TString;
}>;
type ApplyPatchToolDefinition = ToolDefinition<typeof APPLY_PATCH_PARAMETERS, ApplyPatchToolDetails>;
export type ApplyPatchRenderCall = NonNullable<ApplyPatchToolDefinition["renderCall"]>;
export type ApplyPatchRenderResult = NonNullable<ApplyPatchToolDefinition["renderResult"]>;
export interface ApplyPatchToolOptions {
    customRustBinariesDir?: string | undefined;
    promptSnippet?: boolean | undefined;
    showDiffWhenCollapsed?: boolean | undefined;
    renderCall?: ApplyPatchRenderCall | undefined;
    renderResult?: ApplyPatchRenderResult | undefined;
}
export type { ExecutePatchResult } from "../../patch/types.ts";
export type { ApplyPatchPartialFailureDetails, ApplyPatchSuccessDetails, ApplyPatchToolDetails, } from "./render-state.ts";
export { clearApplyPatchRenderState, isApplyPatchToolDetails } from "./render-state.ts";
export declare function createApplyPatchTool(options?: ApplyPatchToolOptions): ApplyPatchToolDefinition;
export declare function registerApplyPatchTool(pi: ExtensionAPI, options?: ApplyPatchToolOptions): void;
export declare function registerApplyPatchResultEvent(pi: ExtensionAPI): void;
