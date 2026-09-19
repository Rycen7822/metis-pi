import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolProvider } from "./shared-runtime.js";
export interface RegisterCodeModeToolsOptions extends CodeModeToolProvider {
}
export interface CodeModeRegistration {
    prepare(ctx?: unknown): Promise<void> | undefined;
    refreshPromptTools(systemPrompt: string, ctx?: unknown): string;
    checkpointNotebook(): Promise<void>;
    shutdownHost(): Promise<void>;
    shutdown(): Promise<void>;
}
export declare function registerCustomTools(pi: ExtensionAPI, toolsDir?: string | readonly string[], options?: {
    isActive?(ctx: unknown): boolean;
}): Promise<CodeModeRegistration>;
export declare function registerCodeModeTools(pi: ExtensionAPI, options: RegisterCodeModeToolsOptions): Promise<CodeModeRegistration>;
