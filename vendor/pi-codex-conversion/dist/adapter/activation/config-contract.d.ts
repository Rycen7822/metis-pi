import type { ExecutionMode } from "./execution-mode.ts";
export type CodexVerbosity = "low" | "medium" | "high";
export type CacheDiagnosticsMode = "off" | "status" | "status-and-log";
export type CompactToolsMode = "off" | "on" | "minimal";
export type LunaCacheKeepaliveMinutes = 0 | 5 | 10 | 15;
export type AllProvidersMode = "off" | "on" | "extras";
export type ContextManagementMode = "off" | "local" | "tree" | "remote";
export type V2UserMessageRetention = 16 | 32 | 64;
export declare const MIN_NOTEBOOK_HEAP_MIB = 256;
export declare const MAX_NOTEBOOK_HEAP_MIB = 65536;
export declare const V2_USER_MESSAGE_RETENTION_OPTIONS: readonly V2UserMessageRetention[];
export declare const LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS: readonly LunaCacheKeepaliveMinutes[];
export interface CodexConversionConfig {
    executionMode: ExecutionMode;
    prompt: {
        heavySystemPromptOverwrite: boolean;
    };
    scope: {
        allProviders: AllProvidersMode;
        additionalProviders: string[];
    };
    tools: {
        autoReasoning: boolean;
        customRustBinariesDir: string;
        viewImageFallback: boolean;
        applyPatchOnly: boolean;
        viewImageOnly: boolean;
    };
    ui: {
        statusLine: boolean;
        toolRenaming: boolean;
        compactTools: CompactToolsMode;
        codeModeDetails: boolean;
        backgroundShellWidget: boolean;
        backgroundShellToggleShortcut: string;
        backgroundShellPrevShortcut: string;
        backgroundShellNextShortcut: string;
        backgroundShellCloseShortcut: string;
    };
    compaction: {
        contextManagement: ContextManagementMode;
        hybridCompaction: boolean;
        responsesCompaction: boolean;
        portableSummary: boolean;
        v2UserMessageRetention: V2UserMessageRetention;
    };
    notebook: {
        maxHeapMiB: number;
        plainCommandOutput: boolean;
        profile?: string | undefined;
    };
    openai: {
        fast: boolean;
        verbosity: CodexVerbosity;
        lunaCacheKeepaliveMinutes: LunaCacheKeepaliveMinutes;
        cacheKeepalive: boolean;
        proxyResponsesLite: boolean;
        forceCachedWebSockets: boolean;
        cacheDiagnostics: CacheDiagnosticsMode;
        harnessIdentifierHeader: boolean;
    };
}
export declare const DEFAULT_CODEX_CONVERSION_CONFIG: CodexConversionConfig;
