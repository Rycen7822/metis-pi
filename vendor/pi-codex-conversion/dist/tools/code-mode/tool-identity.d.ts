import type { CodeModeToolDefinition, CodeModeToolIdentity } from "./types.ts";
export declare function codeModeGlobalName(toolKey: string): string;
export declare function translateCodeModeUsage(usage: string, toolName: string): string;
export declare function translateCodeModeToolReferences(text: string, toolName: string): string;
export declare function translateCodeModeGuideline(guideline: string, toolName: string): string;
export declare function resolveCodeModeToolIdentity(tool: CodeModeToolDefinition): CodeModeToolIdentity;
export declare function codeModeNameForToolIdentity(identity: CodeModeToolIdentity): string;
