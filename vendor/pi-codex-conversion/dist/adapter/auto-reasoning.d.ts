import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "./activation/state.ts";
type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;
declare const PARAMETERS: Type.TObject<{
    level: Type.TUnsafe<"low" | "medium" | "high">;
}>;
interface AutoReasoning {
    begin(ctx: ExtensionContext): void;
    settle(ctx: ExtensionContext): void;
    tool: ToolDefinition<typeof PARAMETERS, {
        level: Level;
        floor: Level;
    }>;
}
export declare function createAutoReasoning(pi: ExtensionAPI, state: AdapterState): AutoReasoning;
export {};
