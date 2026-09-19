import type { CustomToolDefinition } from "./types.js";
export declare function runCustomTool(tool: CustomToolDefinition, input: unknown, cwd: string, signal?: AbortSignal): Promise<string>;
