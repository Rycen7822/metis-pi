import { DEFAULT_VOICE_CONTEXT_REASONING, LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS, REALTIME_V3_VOICES, VOICE_CONTEXT_REASONING_LEVELS, } from "./config-contract.js";
import { normalizeOptionalString } from "./config-values.js";
export { isObject } from "./config-values.js";
export function normalizeAllProvidersMode(value) {
    if (value === true)
        return "on";
    if (value === false)
        return "off";
    return value === "off" || value === "on" || value === "extras"
        ? value
        : undefined;
}
export function normalizeCompactToolsMode(value) {
    if (value === true)
        return "on";
    if (value === false)
        return "off";
    return value === "off" || value === "on" || value === "minimal"
        ? value
        : undefined;
}
export function normalizeContextManagementMode(value) {
    return value === "off" ||
        value === "local" ||
        value === "tree" ||
        value === "remote"
        ? value
        : undefined;
}
export function normalizeCodexVerbosity(value) {
    if (typeof value !== "string")
        return undefined;
    const normalized = value.trim().toLowerCase();
    return normalized === "low" ||
        normalized === "medium" ||
        normalized === "high"
        ? normalized
        : undefined;
}
export function normalizeCacheDiagnosticsMode(value) {
    return value === "off" || value === "status" || value === "status-and-log"
        ? value
        : undefined;
}
export function normalizeLunaCacheKeepaliveMinutes(value) {
    return LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS.includes(value)
        ? value
        : undefined;
}
export function normalizeV2UserMessageRetention(value) {
    return value === 16 || value === 32 || value === 64 ? value : undefined;
}
export function normalizeDictationShortcutMode(value) {
    return value === "push" || value === "toggle" ? value : undefined;
}
export function normalizeRealtimeV3Voice(value) {
    return typeof value === "string"
        ? REALTIME_V3_VOICES.find((voice) => voice === value)
        : undefined;
}
export function normalizeProviderList(value) {
    if (!Array.isArray(value))
        return [];
    return [
        ...new Set(value
            .filter((entry) => typeof entry === "string")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)),
    ];
}
export function normalizeVoiceContextReasoning(value) {
    return typeof value === "string" &&
        VOICE_CONTEXT_REASONING_LEVELS.includes(value)
        ? value
        : DEFAULT_VOICE_CONTEXT_REASONING;
}
export function normalizeCustomRustBinariesDir(value) {
    return normalizeOptionalString(value) ?? "";
}
