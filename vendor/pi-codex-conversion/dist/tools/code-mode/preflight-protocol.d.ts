import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
export declare const PREFLIGHT_REQUEST_CHANNEL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1/request";
export declare const PREFLIGHT_AVAILABLE_CHANNEL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1/available";
export interface CodeModeToolPreflightCall {
    toolName: string;
    input: unknown;
    toolCallId: string;
    cwd: string;
    extensionContext: ExtensionContext;
    signal: AbortSignal;
}
export type CodeModeToolPreflightResult = {
    block: true;
    reason: string;
} | {
    block?: false;
};
export type CodeModeToolPreflight = (call: CodeModeToolPreflightCall) => CodeModeToolPreflightResult | void | Promise<CodeModeToolPreflightResult | void>;
export type CodeModeToolCompletionCall = CodeModeToolPreflightCall & ({
    status: "success";
    result: unknown;
} | {
    status: "error";
    phase: "preflight" | "execution";
    error: string;
    result: unknown;
});
export type CodeModeToolCompletion = (call: CodeModeToolCompletionCall) => void | Promise<void>;
export interface PreflightBroker {
    protocol: typeof PREFLIGHT_PROTOCOL;
    isActive(): boolean;
    register(preflight: CodeModeToolPreflight): () => void;
    registerCompletion?(completion: CodeModeToolCompletion): () => void;
}
export declare function isProtocolRequest(value: unknown): boolean;
export declare function isPreflightBroker(value: unknown): value is PreflightBroker;
