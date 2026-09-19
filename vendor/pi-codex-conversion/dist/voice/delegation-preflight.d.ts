import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeRegistration } from "../tools/code-mode/tools.ts";
import type { CodexExtensionRuntime } from "../extension/runtime.ts";
import type { PreparedVoiceDelegation } from "./session-messages.ts";
export declare function prepareVoiceDelegation(runtime: CodexExtensionRuntime, codeMode: CodeModeRegistration, ctx: ExtensionContext, signal: AbortSignal): Promise<PreparedVoiceDelegation | undefined>;
