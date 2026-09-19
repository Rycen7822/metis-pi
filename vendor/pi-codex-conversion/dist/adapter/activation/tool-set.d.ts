import type { ContextManagementMode } from "./config-contract.ts";
export declare const STATUS_KEY = "codex-adapter";
export declare const STATUS_TEXT = "Codex adapter";
interface StatusTheme {
    fg(role: string, text: string): string;
}
export declare function buildExtraToolsOnlyStatusText(tools: string[], theme?: StatusTheme | undefined): string;
export declare function buildStatusText(options: {
    mode?: "normal" | "code" | "notebook" | undefined;
    verbosity?: string | undefined;
    fast: boolean;
    useOnAllModels: boolean;
    additionalProvider?: boolean | undefined;
    compaction?: boolean | undefined;
    contextManagement?: ContextManagementMode | undefined;
    weeklyUsageLeft?: number | undefined;
}, theme?: StatusTheme | undefined): string;
export declare const DEFAULT_TOOL_NAMES: string[];
export declare const SHELL_ADAPTER_TOOL_NAMES: string[];
export declare const APPLY_PATCH_TOOL_NAME = "apply_patch";
export declare const CORE_ADAPTER_TOOL_NAMES: string[];
export declare const CODE_MODE_TOOL_NAMES: string[];
export declare const NOTEBOOK_MODE_TOOL_NAMES: string[];
export declare const VIEW_IMAGE_TOOL_NAME = "view_image";
export declare const CONTEXT_WINDOW_TOOL_NAMES: string[];
export declare const CONTEXT_DIRECT_TOOL_NAMES: string[];
export declare const CONTEXT_MANAGEMENT_TOOL_NAMES: string[];
export {};
