import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CodeModeToolCompletion, type CodeModeToolPreflightCall } from "./preflight-protocol.js";
import type { ToolExecutionContext } from "./types.js";
export type CodeModeToolPreflightRunner = (call: CodeModeToolPreflightCall) => Promise<void>;
interface BrokerRegistration {
    run: CodeModeToolPreflightRunner;
    complete: CodeModeToolCompletion;
}
export declare function registerCodeModePreflightBroker(pi: ExtensionAPI): BrokerRegistration;
export declare function runCodeModeToolPreflight(toolName: string, input: unknown, context: ToolExecutionContext, signal: AbortSignal): Promise<void>;
export {};
