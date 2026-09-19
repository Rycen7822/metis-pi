import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodexExtensionRuntime } from "../extension/runtime.ts";
import { type CodeModeRegistration } from "../tools/code-mode/tools.ts";
export declare function registerCodexCodeMode(pi: ExtensionAPI, runtime: CodexExtensionRuntime): Promise<CodeModeRegistration>;
