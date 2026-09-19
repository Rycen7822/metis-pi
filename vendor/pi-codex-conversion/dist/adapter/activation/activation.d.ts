import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CodexRuntimePlan } from "./runtime-plan.ts";
import type { AdapterState } from "./state.ts";
export declare function syncAdapter(pi: ExtensionAPI, ctx: ExtensionContext, state: AdapterState): CodexRuntimePlan;
export declare function mergeAdapterTools(activeTools: string[], adapterTools: string[], adapterOwnedTools?: string[]): string[];
export declare function restoreTools(previousTools: string[], activeTools: string[], adapterOwnedTools?: string[]): string[];
export declare function stripAdapterTools(toolNames: string[], adapterOwnedTools?: string[]): string[];
