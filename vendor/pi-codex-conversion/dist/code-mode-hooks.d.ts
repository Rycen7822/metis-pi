import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolCompletion } from "./tools/code-mode/preflight-protocol.js";
export { registerCodeModeToolPreflight, type CodeModeToolPreflight, type CodeModeToolPreflightCall, type CodeModeToolPreflightResult, type CodeModeToolPreflightRegistration, } from "./code-mode-preflight.js";
export type { CodeModeToolCompletion, CodeModeToolCompletionCall, } from "./tools/code-mode/preflight-protocol.js";
export interface CodeModeToolCompletionRegistration {
    readonly available: boolean;
    dispose(): void;
}
export declare function registerCodeModeToolCompletion(pi: ExtensionAPI, completion: CodeModeToolCompletion): CodeModeToolCompletionRegistration;
