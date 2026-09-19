import type { CustomToolDefinition } from "./types.js";
export interface CustomToolDiscoveryError {
    path: string;
    message: string;
}
export interface CustomToolDiscoveryResult {
    tools: CustomToolDefinition[];
    errors: CustomToolDiscoveryError[];
}
export declare const CUSTOM_TOOLS_DIRNAME = "codex-conversion-custom-tools";
export declare function getCustomToolsDir(agentDir?: string): string;
export declare function getProjectCustomToolsDir(launchDir?: string): string;
export declare function parseCustomTool(path: string, text: string): CustomToolDefinition;
export declare function discoverCustomToolsFromDirectories(dirs: readonly string[]): CustomToolDiscoveryResult;
