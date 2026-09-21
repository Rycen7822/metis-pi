import { DEFAULT_CODEX_CONVERSION_CONFIG, LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS, normalizeCodexVerbosity, } from "../../adapter/activation/config.js";
import { configToggle, projectCacheKeepalive, setting } from "./config-items-shared.js";
export function buildOpenAISettings(config) {
    return [
        configToggle(config, "openai", "fast", "Fast mode", "Request priority processing where supported. May use more quota or cost more."),
        {
            item: {
                id: "lunaCacheKeepaliveMinutes",
                description: "Send idle requests every 2.5 minutes for this duration to keep Luna's prompt cache warm. Uses quota.",
                label: "Luna cache keepalive (global)",
                currentValue: config.openai.lunaCacheKeepaliveMinutes === 0
                    ? "off"
                    : `${config.openai.lunaCacheKeepaliveMinutes} mins`,
                values: LUNA_CACHE_KEEPALIVE_MINUTES_OPTIONS.map((minutes) => minutes === 0 ? "off" : `${minutes} mins`),
            },
            action: "global-luna-cache-keepalive",
        },
        projectCacheKeepalive("cacheKeepalive", "Sol/Terra cache keepalive (this project)", config.openai.cacheKeepalive),
        setting({
            id: "verbosity",
            description: "Set the model's preferred answer detail. This does not change its reasoning effort.",
            label: "Verbosity",
            currentValue: config.openai.verbosity,
            values: ["low", "medium", "high"],
        }, (value, current) => ({
            ...current,
            openai: {
                ...current.openai,
                verbosity: normalizeCodexVerbosity(value) ??
                    DEFAULT_CODEX_CONVERSION_CONFIG.openai.verbosity,
            },
        })),
        configToggle(config, "openai", "proxyResponsesLite", "Proxy Responses Lite", "Use Responses Lite for supported models on configured proxies in Code or Notebook mode. Requires proxy support.", "responsesLite"),
        configToggle(config, "openai", "forceCachedWebSockets", "Cached WebSocket upgrade", "Upgrade explicit WebSocket transport to reuse connections between requests. Leaves SSE unchanged."),
        setting({
            id: "harnessIdentifierHeader",
            description: "Identify this extension in the request originator header instead of the default Pi identifier.",
            label: "Harness identifier header",
            currentValue: config.openai.harnessIdentifierHeader
                ? "pi-codex-conversion <3"
                : "off",
            values: ["off", "pi-codex-conversion <3"],
        }, (value, current) => ({
            ...current,
            openai: {
                ...current.openai,
                harnessIdentifierHeader: value !== "off",
            },
        })),
        setting({
            id: "cacheDiagnostics",
            description: "Show cache and continuation status below the editor, with optional diagnostic logging.",
            label: "Cache diagnostics",
            currentValue: formatCacheDiagnostics(config.openai.cacheDiagnostics),
            values: ["Off", "Status", "Status + log"],
        }, (value, current) => ({
            ...current,
            openai: {
                ...current.openai,
                cacheDiagnostics: parseCacheDiagnostics(value),
            },
        })),
    ];
}
function formatCacheDiagnostics(mode) {
    if (mode === "status-and-log")
        return "Status + log";
    if (mode === "status")
        return "Status";
    return "Off";
}
function parseCacheDiagnostics(value) {
    if (value === "Status + log")
        return "status-and-log";
    if (value === "Status")
        return "status";
    return "off";
}
