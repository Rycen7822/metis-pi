export const MIN_NOTEBOOK_HEAP_MIB = 256;
export const MAX_NOTEBOOK_HEAP_MIB = 65_536;
export const V2_USER_MESSAGE_RETENTION_OPTIONS = [16, 32, 64];
export const LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS = [0, 5, 10, 15];
export const DEFAULT_CODEX_CONVERSION_CONFIG = {
    executionMode: "normal",
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
