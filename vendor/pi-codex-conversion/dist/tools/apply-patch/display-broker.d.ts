import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type ApplyPatchToolDetails } from "./render-state.js";
export interface CapturedApplyPatchOutcome {
    content?: string | undefined;
    details?: ApplyPatchToolDetails | undefined;
    error?: string | undefined;
    isError: boolean;
}
export declare function shouldCompactApplyPatchDisplay(toolCallId?: string, executionStarted?: boolean): boolean;
export declare function recordApplyPatchDisplayInput(toolCallId: string, input: string): void;
export declare function recordApplyPatchDisplayOutcome(toolCallId: string, outcome: CapturedApplyPatchOutcome): void;
export declare function registerApplyPatchDisplayBroker(pi: ExtensionAPI): void;
