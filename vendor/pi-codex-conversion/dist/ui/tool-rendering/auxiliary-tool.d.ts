import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
interface AuxiliaryToolPresentation {
    active: string;
    complete: string;
    target?: string | undefined;
    summary?: string | undefined;
    body?: string | undefined;
    warning?: string | undefined;
}
/** Presentation only: never replace the tool's model-visible content or details. */
export declare function auxiliaryToolRenderers(failureTitle: string, present: (args: Record<string, unknown>, result?: AgentToolResult<unknown>) => AuxiliaryToolPresentation): Pick<ToolDefinition, "renderCall" | "renderResult">;
export declare function displayRecord(value: unknown): Record<string, unknown>;
export declare function inlineToolText(value: unknown): string | undefined;
export {};
