import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolPreflight } from "./tools/code-mode/preflight-protocol.js";
export type { CodeModeToolPreflight, CodeModeToolPreflightCall, CodeModeToolPreflightResult, } from "./tools/code-mode/preflight-protocol.js";
export interface CodeModeToolPreflightRegistration {
    readonly available: boolean;
    dispose(): void;
}
export declare function registerCodeModeToolPreflight(pi: ExtensionAPI, preflight: CodeModeToolPreflight): CodeModeToolPreflightRegistration;
