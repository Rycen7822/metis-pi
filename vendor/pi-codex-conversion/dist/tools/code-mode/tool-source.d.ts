import type { CodeModeToolDefinition } from "./types.js";
export declare function scopeAllToolsToDeferredCustom(source: string, tools: CodeModeToolDefinition[]): string;
export declare function directToolYieldTime(code: string, tools: CodeModeToolDefinition[]): number | null;
