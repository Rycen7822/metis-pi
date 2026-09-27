import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexExtensionRuntime } from "../extension/runtime.ts";
import { type CodeModeRegistration } from "../tools/code-mode/tools.ts";
import type { ProgrammaticCodeModeToolDefinition } from "../tools/code-mode/types.ts";
export declare function registerCodexCodeMode(pi: ExtensionAPI, runtime: CodexExtensionRuntime): Promise<CodeModeRegistration>;
export declare function createNestedTools(pi: ExtensionAPI, runtime: CodexExtensionRuntime, ctx?: ExtensionContext): ProgrammaticCodeModeToolDefinition[];
