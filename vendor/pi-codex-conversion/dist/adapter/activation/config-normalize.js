import { DEFAULT_CODEX_CONVERSION_CONFIG, MAX_NOTEBOOK_HEAP_MIB, MIN_NOTEBOOK_HEAP_MIB, } from "./config-contract.js";
import { isObject, normalizeAllProvidersMode, normalizeCacheDiagnosticsMode, normalizeCodexVerbosity, normalizeCompactToolsMode, normalizeContextManagementMode, normalizeCustomRustBinariesDir, normalizeLunaCacheKeepaliveMinutes, normalizeProviderList, normalizeV2UserMessageRetention, } from "./config-normalizers.js";
import { normalizeBoolean, normalizeIntegerInRange, normalizeNotebookProfile, normalizeString, } from "./config-values.js";
import { normalizeExecutionMode } from "./execution-mode.js";
// Default booleans have one rule. Enum/string/optional fields and dependencies stay explicit below.
function booleans(section, values) {
    return Object.fromEntries(Object.entries(DEFAULT_CODEX_CONVERSION_CONFIG[section])
        .filter(([, fallback]) => typeof fallback === "boolean")
        .map(([key, fallback]) => [key, normalizeBoolean(values[key], fallback)]));
}
export function normalizeCodexConversionConfig(value) {
    const defaults = DEFAULT_CODEX_CONVERSION_CONFIG;
    if (!isObject(value))
        return structuredClone(defaults);
    const prompt = isObject(value["prompt"]) ? value["prompt"] : {};
    const scope = isObject(value["scope"]) ? value["scope"] : {};
    const tools = isObject(value["tools"]) ? value["tools"] : {};
    const ui = { ...(isObject(value["ui"]) ? value["ui"] : {}) };
    if (typeof ui["toolRenaming"] !== "boolean")
        ui["toolRenaming"] = ui["toolRendering"];
    const compaction = isObject(value["compaction"]) ? value["compaction"] : {};
    const notebook = isObject(value["notebook"]) ? value["notebook"] : {};
    const openai = isObject(value["openai"]) ? value["openai"] : {};
    const notebookProfile = normalizeNotebookProfile(notebook["profile"]);
    const executionMode = normalizeExecutionMode(value["executionMode"]) ??
        defaults.executionMode;
    const contextManagement = normalizeContextManagementMode(compaction["contextManagement"]) ??
        defaults.compaction.contextManagement;
    const config = {
        executionMode,
        prompt: {
            ...booleans("prompt", prompt),
        },
        scope: {
            allProviders: normalizeAllProvidersMode(scope["allProviders"]) ??
                defaults.scope["allProviders"],
            additionalProviders: normalizeProviderList(scope["additionalProviders"]),
        },
        tools: {
            ...booleans("tools", tools),
            customRustBinariesDir: normalizeCustomRustBinariesDir(tools["customRustBinariesDir"]),
        },
        ui: {
            ...booleans("ui", ui),
            compactTools: normalizeCompactToolsMode(ui["compactTools"])
                ?? defaults.ui.compactTools,
            backgroundShellToggleShortcut: normalizeString(ui["backgroundShellToggleShortcut"], defaults.ui["backgroundShellToggleShortcut"]),
            backgroundShellPrevShortcut: normalizeString(ui["backgroundShellPrevShortcut"], defaults.ui["backgroundShellPrevShortcut"]),
            backgroundShellNextShortcut: normalizeString(ui["backgroundShellNextShortcut"], defaults.ui["backgroundShellNextShortcut"]),
            backgroundShellCloseShortcut: normalizeString(ui["backgroundShellCloseShortcut"], defaults.ui["backgroundShellCloseShortcut"]),
        },
        compaction: {
            ...booleans("compaction", compaction),
            contextManagement,
            v2UserMessageRetention: normalizeV2UserMessageRetention(compaction["v2UserMessageRetention"]) ??
                defaults.compaction.v2UserMessageRetention,
        },
        notebook: {
            ...booleans("notebook", notebook),
            maxHeapMiB: normalizeIntegerInRange(notebook["maxHeapMiB"], defaults.notebook.maxHeapMiB, MIN_NOTEBOOK_HEAP_MIB, MAX_NOTEBOOK_HEAP_MIB),
            ...(notebookProfile ? { profile: notebookProfile } : {}),
        },
        openai: {
            ...booleans("openai", openai),
            verbosity: normalizeCodexVerbosity(openai["verbosity"]) ??
                defaults.openai["verbosity"],
            lunaCacheKeepaliveMinutes: normalizeLunaCacheKeepaliveMinutes(openai["lunaCacheKeepaliveMinutes"]) ?? defaults.openai.lunaCacheKeepaliveMinutes,
            cacheDiagnostics: normalizeCacheDiagnosticsMode(openai["cacheDiagnostics"]) ??
                defaults.openai.cacheDiagnostics,
        },
    };
    // Apply dependent switches once, after their own values have been normalized.
    config.compaction.hybridCompaction &&= contextManagement !== "off";
    config.compaction.responsesCompaction &&= contextManagement === "off";
    config.compaction.portableSummary &&= config.compaction.responsesCompaction;
    return config;
}
