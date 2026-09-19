import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ApplyPatchToolDetails } from "./tools/apply-patch/render-state.js";
export interface ApplyPatchDisplayData {
    toolCallId: string;
    input: string;
    details?: ApplyPatchToolDetails | undefined;
    content?: string | undefined;
    error?: string | undefined;
    isError: boolean;
    source: "direct" | "nested";
}
export interface ApplyPatchDisplayOptions {
    customType: string;
    render: EntryRenderer<ApplyPatchDisplayData>;
}
export interface ApplyPatchDisplayRegistration {
    readonly available: boolean;
    dispose(): void;
}
export declare function registerApplyPatchDisplay(pi: ExtensionAPI, options: ApplyPatchDisplayOptions): ApplyPatchDisplayRegistration;
