import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../adapter/activation/state.ts";
import type { CodexRuntimePlan } from "../adapter/activation/runtime-plan.ts";
export declare function renderCodexStatus(ctx: ExtensionContext, state: AdapterState, plan: Extract<CodexRuntimePlan, {
    kind: "normal" | "code" | "notebook";
}>): void;
