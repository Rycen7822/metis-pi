import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AdapterState } from "../adapter/activation/state.ts";
declare const EMPTY_PARAMETERS: Type.TObject<{}>;
interface NewContextDetails {
    started: boolean;
}
export interface ContextRemainingDetails {
    remainingTokens?: number | undefined;
    windowId?: string | undefined;
    contextWindow: number;
}
export declare function createContextWindowTools(pi: ExtensionAPI, state: AdapterState): [
    ToolDefinition<typeof EMPTY_PARAMETERS, NewContextDetails>,
    ToolDefinition<typeof EMPTY_PARAMETERS, ContextRemainingDetails>
];
export declare function registerContextManagementTools(pi: ExtensionAPI, state: AdapterState): void;
export {};
