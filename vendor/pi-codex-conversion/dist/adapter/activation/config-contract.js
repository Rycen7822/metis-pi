export const MIN_NOTEBOOK_HEAP_MIB = 256;
export const MAX_NOTEBOOK_HEAP_MIB = 65_536;
export const VOICE_CONTEXT_REASONING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
export const DEFAULT_VOICE_CONTEXT_REASONING = "high";
export const REALTIME_V3_VOICES = [
    "juniper",
    "maple",
    "spruce",
    "ember",
    "vale",
    "breeze",
    "arbor",
    "sol",
    "cove",
];
export const V2_USER_MESSAGE_RETENTION_OPTIONS = [16, 32, 64];
export const LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS = [0, 5, 10, 15];
export const DEFAULT_CODEX_CONVERSION_CONFIG = {
    executionMode: "normal",
    voiceFeaturesOnly: false,
    prompt: { heavySystemPromptOverwrite: false },
    scope: { allProviders: "off", additionalProviders: [] },
    tools: {
        autoReasoning: false,
        customRustBinariesDir: "",
        viewImageFallback: false,
        applyPatchOnly: false,
        viewImageOnly: false,
    },
    ui: {
        statusLine: true,
        toolRenaming: true,
        compactTools: "off",
        codeModeDetails: false,
        backgroundShellWidget: true,
        backgroundShellToggleShortcut: "alt+w",
        backgroundShellPrevShortcut: "alt+q",
        backgroundShellNextShortcut: "alt+e",
        backgroundShellCloseShortcut: "alt+r",
    },
    compaction: {
        contextManagement: "off",
        hybridCompaction: false,
        responsesCompaction: false,
        portableSummary: false,
        v2UserMessageRetention: 64,
    },
    notebook: { maxHeapMiB: 4_096, plainCommandOutput: false },
    voice: {
        v3Voice: "cove",
        autoResumeRealtime: true,
        refreshRealtimeAfterCompaction: true,
        audioSetupCompleted: false,
        delegationAcknowledgements: true,
        forwardReasoningSummaries: true,
        dictationShortcut: "ctrl+alt+d",
        realtimeShortcut: "ctrl+alt+space",
        muteShortcut: "ctrl+alt+m",
        serverShortcut: "ctrl+alt+g",
        dictationShortcutMode: "push",
        contextModel: {
            provider: "openai-codex",
            modelId: "gpt-5.6-luna",
        },
        contextReasoning: DEFAULT_VOICE_CONTEXT_REASONING,
    },
    openai: {
        fast: false,
        verbosity: "low",
        lunaCacheKeepaliveMinutes: 0,
        cacheKeepalive: false,
        proxyResponsesLite: false,
        forceCachedWebSockets: true,
        cacheDiagnostics: "off",
        harnessIdentifierHeader: false,
    },
};
