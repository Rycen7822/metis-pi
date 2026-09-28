import { clearFolderCodexConversionConfig, getCodexConversionConfigPath, getProjectCodexConversionConfigPath, hasFolderCodexConversionConfig, materializeFolderCodexConversionConfig, readCodexConversionConfig, readEffectiveCodexConversionConfig, readLayeredCodexConversionConfig, setGlobalCodexLunaCacheKeepalive, setProjectCodexCacheKeepalive, writeCodexConversionConfig, } from "../../adapter/activation/config-store.js";
import { syncAdapter } from "../../adapter/activation/activation.js";
import { ROUTABLE_SETTINGS_TABS, parseSettingsTab } from "./tabs.js";
import { openCodexSettingsScreen } from "./screen.js";
const CODEX_COMMAND_COMPLETIONS = ROUTABLE_SETTINGS_TABS.map(({ id }) => id);
const CODEX_USAGE = "Usage: /codex [context|tools|openai|display|usage|about]";
export function registerCodexCommand(pi, state, onConfigApplied) {
    function effectiveConfig(ctx) {
        return readEffectiveCodexConversionConfig({
            cwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
        });
    }
    function applyEffectiveConfig(ctx, previousConfig) {
        const config = effectiveConfig(ctx);
        state.config = config;
        state.executionMode = config.executionMode;
        onConfigApplied?.(config, ctx, previousConfig);
        syncAdapter(pi, ctx, state);
    }
    function saveAndApply(ctx, scope, nextConfig) {
        const path = scope === "folder"
            ? getProjectCodexConversionConfigPath(ctx.cwd)
            : getCodexConversionConfigPath();
        const writeResult = writeCodexConversionConfig(nextConfig, path, scope === "folder");
        if (!writeResult.ok) {
            ctx.ui.notify(`Failed to save Codex settings: ${writeResult.error}`, "error");
            return false;
        }
        const previousConfig = state.config;
        applyEffectiveConfig(ctx, previousConfig);
        return true;
    }
    async function openSettings(ctx, tab) {
        if (!ctx.hasUI) {
            if (tab === "usage") {
                const [{ fetchCodexUsage }, { formatCodexUsage }] = await Promise.all([
                    import("../../codex-usage/client.js"),
                    import("../../codex-usage/format.js"),
                ]);
                try {
                    ctx.ui.notify(formatCodexUsage(await fetchCodexUsage(ctx)), "info");
                }
                catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
                }
                return;
            }
            ctx.ui.notify(formatCodexSettings(state.config), "info");
            return;
        }
        let configScope = hasFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted()) ? "folder" : "global";
        if (configScope === "folder") {
            const materialized = materializeFolderCodexConversionConfig(ctx.cwd, true);
            if (!materialized.ok) {
                ctx.ui.notify(`Could not materialize folder Codex settings: ${materialized.error}`, "error");
                return;
            }
        }
        const readSelectedConfig = () => {
            const effective = effectiveConfig(ctx);
            const selected = configScope === "folder"
                ? readLayeredCodexConversionConfig({ cwd: ctx.cwd, projectTrusted: true })
                : readCodexConversionConfig();
            return {
                ...selected,
                openai: {
                    ...selected.openai,
                    lunaCacheKeepaliveMinutes: effective.openai.lunaCacheKeepaliveMinutes,
                    cacheKeepalive: effective.openai.cacheKeepalive,
                },
            };
        };
        await openCodexSettingsScreen(ctx, {
            initialConfig: readSelectedConfig(),
            initialTab: tab,
            onChange: (config) => saveAndApply(ctx, configScope, config),
            onGlobalLunaCacheKeepalive: (minutes) => {
                const result = setGlobalCodexLunaCacheKeepalive(minutes);
                if (!result.ok) {
                    ctx.ui.notify(`Failed to save global Luna cache keepalive: ${result.error}`, "error");
                    return undefined;
                }
                const previousConfig = state.config;
                applyEffectiveConfig(ctx, previousConfig);
                return readSelectedConfig();
            },
            onProjectCacheKeepalive: (enabled) => {
                const result = setProjectCodexCacheKeepalive(ctx.cwd, ctx.isProjectTrusted(), enabled);
                if (!result.ok) {
                    ctx.ui.notify(`Failed to save project cache keepalive: ${result.error}`, "error");
                    return undefined;
                }
                const previousConfig = state.config;
                applyEffectiveConfig(ctx, previousConfig);
                return readSelectedConfig();
            },
            configScope: {
                current: () => configScope,
                canUseFolder: ctx.isProjectTrusted(),
                path: () => configScope === "folder"
                    ? getProjectCodexConversionConfigPath(ctx.cwd)
                    : getCodexConversionConfigPath(),
                reload: readSelectedConfig,
                set: (scope) => {
                    const previousConfig = state.config;
                    const result = scope === "folder"
                        ? materializeFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted())
                        : clearFolderCodexConversionConfig(ctx.cwd, ctx.isProjectTrusted());
                    if (!result.ok) {
                        ctx.ui.notify(`Could not change Codex settings scope: ${result.error}`, "error");
                        return undefined;
                    }
                    configScope = scope;
                    applyEffectiveConfig(ctx, previousConfig);
                    return readSelectedConfig();
                },
            },
        });
    }
    pi.registerCommand("codex", {
        description: "Configure Codex adapter settings",
        getArgumentCompletions: (prefix) => CODEX_COMMAND_COMPLETIONS.filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((value) => ({ label: value, value })),
        handler: async (args, ctx) => {
            state.config = effectiveConfig(ctx);
            const arg = args.trim().toLowerCase();
            const tab = arg ? parseSettingsTab(arg) : "adapter";
            if (tab) {
                await openSettings(ctx, tab);
                return;
            }
            ctx.ui.notify(CODEX_USAGE, "warning");
        },
    });
}
function formatAllProvidersMode(value) {
    return value === "extras" ? "only extras" : value;
}
function formatCodexSettings(config) {
    return `Codex settings: execution ${config.executionMode}, providers ${formatAllProvidersMode(config.scope.allProviders)}, Rust binaries ${config.tools.customRustBinariesDir || "bundled"}, heavy prompt overwrite ${config.prompt.heavySystemPromptOverwrite ? "on" : "off"}, harness identifier ${config.openai.harnessIdentifierHeader ? "on" : "off"}, Proxy Responses Lite ${config.openai.proxyResponsesLite ? "on" : "off"}, context management ${config.compaction.contextManagement}, compaction ${config.compaction.hybridCompaction ? "hybrid (V2 where supported, Pi elsewhere)" : config.compaction.contextManagement !== "off" ? "notes only" : config.compaction.responsesCompaction ? "V2" : "Pi"}, portable summary ${config.compaction.portableSummary ? "on" : "off"}, Luna cache keepalive ${config.openai.lunaCacheKeepaliveMinutes === 0 ? "off" : `${config.openai.lunaCacheKeepaliveMinutes} mins`}, Sol/Terra cache keepalive ${config.openai.cacheKeepalive ? "25 mins" : "off"}, cache diagnostics ${config.openai.cacheDiagnostics}, fast ${config.openai.fast ? "on" : "off"}, verbosity ${config.openai.verbosity}`;
}
