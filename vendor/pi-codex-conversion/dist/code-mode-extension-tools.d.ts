import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProgrammaticCodeModeToolDefinition } from "./tools/code-mode/types.ts";
export type CodeModeExtensionToolProvider = (context: ExtensionContext | undefined) => readonly ProgrammaticCodeModeToolDefinition[];
export interface CodeModeExtensionToolRegistrationOptions {
    isActive?(context: ExtensionContext | undefined): boolean;
}
export interface CodeModeExtensionToolRegistration {
    refresh(): void;
    unregister(): void;
}
export declare function registerCodeModeExtensionTools(pi: ExtensionAPI, provider: CodeModeExtensionToolProvider, options?: CodeModeExtensionToolRegistrationOptions): CodeModeExtensionToolRegistration;
export declare function onCodeModeExtensionToolsRefresh(pi: ExtensionAPI, handler: () => void): () => void;
export declare function getCodeModeExtensionTools(pi: ExtensionAPI, context: ExtensionContext | undefined): ProgrammaticCodeModeToolDefinition[];
export declare function getCodeModeExtensionToolSnapshot(pi: ExtensionAPI, context: ExtensionContext | undefined, refreshGates?: boolean): {
    tools: ProgrammaticCodeModeToolDefinition[];
    allToolNames: string[];
};
