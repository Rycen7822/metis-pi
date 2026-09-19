import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodeModeProxyProviderRegistration } from "../providers/code-mode-proxy-provider.ts";
import type { CodeModeRegistration } from "../tools/code-mode/tools.ts";
import type { CodexExtensionRuntime } from "./runtime.ts";
import type { CodexToolRegistration } from "./tools.ts";
import type { CodexUiController } from "./ui.ts";
export declare function prepareCodeModeHost(codeMode: CodeModeRegistration, ctx: ExtensionContext): void;
export declare function registerCodexEvents(pi: ExtensionAPI, runtime: CodexExtensionRuntime, tools: CodexToolRegistration, ui: CodexUiController, codeMode: CodeModeRegistration, proxyProvider: CodeModeProxyProviderRegistration): void;
