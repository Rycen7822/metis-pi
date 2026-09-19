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
export type DictationShortcutMode = "push" | "toggle";
export declare const VOICE_CONTEXT_REASONING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type VoiceContextReasoning = (typeof VOICE_CONTEXT_REASONING_LEVELS)[number];
export declare const DEFAULT_VOICE_CONTEXT_REASONING: VoiceContextReasoning;
export type VoiceContextModel = {
    provider: string;
    modelId: string;
};
export declare const REALTIME_V3_VOICES: readonly ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
export type RealtimeV3Voice = (typeof REALTIME_V3_VOICES)[number];
export declare const V2_USER_MESSAGE_RETENTION_OPTIONS: readonly V2UserMessageRetention[];
export declare const LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS: readonly LunaCacheKeepaliveMinutes[];
export interface CodexConversionConfig {
    executionMode: ExecutionMode;
    voiceFeaturesOnly: boolean;
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
    voice: {
        v3Voice: RealtimeV3Voice;
        autoResumeRealtime: boolean;
        refreshRealtimeAfterCompaction: boolean;
        audioSetupCompleted: boolean;
        delegationAcknowledgements: boolean;
        forwardReasoningSummaries: boolean;
        dictationShortcut: string;
        realtimeShortcut: string;
        muteShortcut: string;
        serverShortcut: string;
        dictationShortcutMode: DictationShortcutMode;
        contextModel?: VoiceContextModel | undefined;
        contextReasoning: VoiceContextReasoning;
        inputDevice?: string | undefined;
        outputDevice?: string | undefined;
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
