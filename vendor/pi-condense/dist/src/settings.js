import { PRUNE_ON_MODES, BATCHING_MODES, SUMMARIZER_THINKING_LEVELS, MIN_BATCH_CHARS_PRESETS, RECOVERY_GRACE_PRESETS, SUMMARIZER_IDLE_TIMEOUT_PRESETS, SUMMARIZER_MAX_TIMEOUT_PRESETS, AUTO_BUDGET_PRESETS, ROLLING_WINDOW_PRESETS, PURGE_COOLDOWN_PRESETS, PURGE_MIN_ARG_PRESETS, DEFAULT_CONFIG, } from "./types.js";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, SettingsList } from "@earendil-works/pi-tui";
import { MAX_BUDGET_WINDOW } from "./budget.js";
import { persistConfig } from "./config.js";
/**
 * Wraps a SettingsList with a border + title, delegating all input handling
 * to the inner list. Container alone doesn't handle input, so we must
 * forward handleInput manually.
 */
class SettingsOverlay extends Container {
    settingsList;
    constructor(title, settingsList) {
        super();
        this.settingsList = settingsList;
        this.addChild(new DynamicBorder());
        this.addChild(new Text(title, 0, 0));
        this.addChild(settingsList);
        this.addChild(new DynamicBorder());
    }
    handleInput(data) {
        this.settingsList.handleInput(data);
    }
    invalidate() {
        this.settingsList.invalidate();
    }
}
const PRUNE_MODE_GUIDANCE = {
    "agent-message": "Recommended default. Batches tool work and prunes once after the final text reply, giving the best balance of automation, context savings, and cache stability.",
    "on-demand": "Maximum manual control. Nothing is pruned until you run /pruner now, so cache invalidation happens only when you choose.",
};
function pruneModeGuidance(mode) {
    return PRUNE_MODE_GUIDANCE[mode] ?? "Controls when summarized tool outputs replace raw tool results in future context.";
}
function pruneModeLabel(mode) {
    return PRUNE_ON_MODES.find((entry) => entry.value === mode)?.label ?? mode;
}
export function summarizerThinkingLabel(level) {
    return SUMMARIZER_THINKING_LEVELS.find((entry) => entry.value === level)?.label ?? level;
}
function summarizerThinkingDescription(level) {
    if (level === "default") {
        return "Preserve old behavior: send no explicit thinking option for summarizer calls.";
    }
    if (level === "off") {
        return "Request no summarizer reasoning where the provider adapter supports it; some providers may fall back to their default.";
    }
    return `Request ${level} thinking/reasoning for summarizer calls where supported.`;
}
function pruneTriggerDescription(mode) {
    return `When to summarize tool outputs. Current mode: ${pruneModeLabel(mode)} (${mode}) — ${pruneModeGuidance(mode)} Press Enter/Space to cycle through modes.`;
}
export function batchingModeLabel(mode) {
    return BATCHING_MODES.find((m) => m.value === mode)?.label ?? mode;
}
function batchingModeDescription(mode) {
    if (mode === "turn") {
        return "Per turn (default): one summary per assistant turn. Keeps summaries small and granular.";
    }
    return "Per agent message: merges all assistant turns between two user messages into one summary. Fewer, larger summaries per conversation exchange.";
}
function pruneStatusLineDescription(config) {
    const base = config.showPruneStatusLine ? "ON" : "OFF";
    if (config.showPruneStatusLine) {
        return `Show the prune footer status line and queued turn notifications. Currently ${base}.`;
    }
    return `Hide the prune footer status line and queued turn notifications. Currently ${base}.`;
}
function quietOversizedSkipsDescription(config) {
    const base = config.quietOversizedSkips ? "ON" : "OFF";
    if (config.quietOversizedSkips) {
        return `Suppress all non-error 'skipped pruning' notifications — both 'oversized' (summary was larger than the raw output) and 'trivial' (batch was below minBatchChars, no LLM call made). The frontier still advances in both cases. Currently ${base}.`;
    }
    return `Show 'skipped pruning' info notifications when a batch is skipped — either because the summary would have been larger than the raw output (oversized) or because the batch was below minBatchChars (trivial, no LLM call). Currently ${base}.`;
}
function minBatchCharsDescription(config) {
    if (config.minBatchChars === 0) {
        return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently 0 — disabled, every batch is sent to the summarizer.`;
    }
    return `Pre-flush guard: skip batches whose total raw resultText is below this many chars (no LLM call, frontier advances anyway). Currently ${config.minBatchChars}. Useful for sessions with many tiny tool calls. Set to 0 to disable.`;
}
function recoveryGraceDescription(config) {
    if (config.recoveryGraceTurns === 0) {
        return "context_tree_query output is stubbed immediately (grace disabled). Set to a positive integer to keep recovered output verbatim for that many user-turn-groups.";
    }
    return `context_tree_query (recovery) output stays verbatim for ${config.recoveryGraceTurns} user-turn-group(s) after recovery, then reverts to the stub. Bounds the recover->re-stub->re-query loop. Currently ${config.recoveryGraceTurns}. Set to 0 to disable.`;
}
function idleTimeoutDescription(config) {
    if (config.summarizerIdleTimeoutMs === 0) {
        return "Summarizer idle timeout DISABLED - a stalled stream is only bounded by the ceiling (or not at all if that is 0 too).";
    }
    return `Abort a summarizer call after ${Math.round(config.summarizerIdleTimeoutMs / 1000)}s of silence (no stream event). Resets on every event, so it never aborts a flowing generation; a timeout feeds the same outage-fallback retry as a provider error. Set 0 to disable.`;
}
function maxTimeoutDescription(config) {
    if (config.summarizerMaxTimeoutMs === 0) {
        return "Summarizer total-duration ceiling DISABLED - only the idle timeout bounds a call.";
    }
    return `Hard ceiling on total duration of a single summarizer call: ${Math.round(config.summarizerMaxTimeoutMs / 1000)}s. Backstop for a stream that dribbles forever without going idle. Set 0 to disable.`;
}
function autoBudgetThresholdDescription(config) {
    const cap = `${MAX_BUDGET_WINDOW / 1000}k`;
    if (config.autoBudgetThreshold == null) {
        return `Token-budget auto-flush: force a prune when context usage reaches this share of the window (or ${cap} tokens, whichever comes first), regardless of prune-on mode. Currently off. Pick a percentage to enable.`;
    }
    const pct = Math.round(config.autoBudgetThreshold * 100);
    return `Token-budget auto-flush: force a prune when context usage reaches ${pct}% of the window or ${cap} tokens, whichever comes first, regardless of prune-on mode. The ${cap} ceiling keeps this reachable on huge-window models. Set to Off to disable.`;
}
export function protectedToolsDisplay(list) {
    return list.length === 0 ? "(none)" : list.join(", ");
}
export function dedupByContentHashDescription(config) {
    const state = config.dedupByContentHash ? "ON" : "OFF";
    if (config.dedupByContentHash) {
        return `Pre-flush content-hash dedup. When a captured tool call's (toolName, normalized resultText) matches a record already in the indexer, the duplicate is registered as an alias of the original — no summarizer LLM call. Currently ${state}.`;
    }
    return `Pre-flush content-hash dedup. Currently ${state}. Identical re-reads will be sent to the summarizer like any other tool call.`;
}
function protectedToolsDescription(config) {
    return `Tool names whose outputs are NEVER pruned (kept verbatim in context). Currently: ${protectedToolsDisplay(config.protectedTools)}. Edit via \`/pruner protected-tools\` for an interactive prompt, or \`/pruner protected-tools <comma-separated names>\` to set directly. Common candidates: todowrite, todoread.`;
}
function protectedPathsDescription(config) {
    return `Glob patterns matched against a tool call's \`args.path\`; matching outputs are NEVER pruned. Currently: ${protectedToolsDisplay(config.protectedPaths)}. Edit via \`/pruner protected-paths\` (interactive) or \`/pruner protected-paths <comma-separated globs>\`. Set to 'none' to disable (kill switch). Default protects skill files and per-repo gauntlet overrides: **/skills/**/*.md, **/gauntlet-overrides.md`;
}
export async function openPrunerSettings(ctx, currentConfig, save, refreshStatus) {
    const config = currentConfig.value;
    const availableModels = ctx.modelRegistry?.getAvailable() ?? [];
    const items = [
        {
            id: "enabled",
            label: "Enabled",
            values: ["true", "false"],
            currentValue: String(config.enabled),
            description: "Enable or disable context pruning",
        },
        {
            id: "showPruneStatusLine",
            label: "Prune status line",
            values: ["true", "false"],
            currentValue: String(config.showPruneStatusLine),
            description: pruneStatusLineDescription(config),
        },
        {
            id: "showOccStatusLine",
            label: "OCC status line",
            values: ["true", "false"],
            currentValue: String(config.showOccStatusLine),
            description: "Show OCC progress and retain its latest result in the footer. Does not affect compaction.",
        },
        {
            id: "pruneOn",
            label: "Prune trigger",
            values: PRUNE_ON_MODES.map((m) => m.value),
            currentValue: config.pruneOn,
            description: pruneTriggerDescription(config.pruneOn),
        },
        {
            id: "summarizerModel",
            label: "Summarizer model",
            values: [config.summarizerModel], // show current value as the cycling option
            currentValue: config.summarizerModel,
            description: "Model used for summarizing tool outputs — press Enter to browse models",
            submenu: (currentValue, done) => {
                const modelItems = [
                    {
                        id: "default",
                        label: "default (active model)",
                        values: ["default"],
                        currentValue: currentValue === "default" ? "default" : "",
                        description: "Use the currently active model for summarization",
                    },
                    ...availableModels.map((m) => {
                        const displayId = `${m.provider}/${m.id}`;
                        return {
                            id: displayId,
                            label: displayId,
                            values: [displayId],
                            currentValue: currentValue === displayId ? displayId : "",
                            description: m.name || displayId,
                        };
                    }),
                ];
                return new SettingsList(modelItems, 15, getSettingsListTheme(), (_id, newValue) => done(newValue), () => done(undefined), // onCancel — ESC closes submenu, returns to parent
                { enableSearch: true });
            },
        },
        {
            id: "summarizerThinking",
            label: "Summarizer thinking",
            values: SUMMARIZER_THINKING_LEVELS.map((level) => level.value),
            currentValue: config.summarizerThinking,
            description: summarizerThinkingDescription(config.summarizerThinking),
        },
        {
            id: "batchingMode",
            label: "Batching mode",
            values: BATCHING_MODES.map((m) => m.value),
            currentValue: config.batchingMode,
            description: batchingModeDescription(config.batchingMode),
        },
        {
            id: "quietOversizedSkips",
            label: "Quiet skip notifications",
            values: ["true", "false"],
            currentValue: String(config.quietOversizedSkips),
            description: quietOversizedSkipsDescription(config),
        },
        {
            id: "minBatchChars",
            label: "Min batch chars",
            values: MIN_BATCH_CHARS_PRESETS.map((p) => p.value),
            currentValue: MIN_BATCH_CHARS_PRESETS.some((p) => p.value === String(config.minBatchChars))
                ? String(config.minBatchChars)
                : MIN_BATCH_CHARS_PRESETS[2].value, // fall back to "1000" if a custom value isn't in the preset cycle
            description: minBatchCharsDescription(config),
        },
        {
            id: "recoveryGraceTurns",
            label: "Recovery grace (user-turn-groups)",
            values: RECOVERY_GRACE_PRESETS.map((p) => p.value),
            currentValue: RECOVERY_GRACE_PRESETS.some((p) => p.value === String(config.recoveryGraceTurns))
                ? String(config.recoveryGraceTurns)
                : RECOVERY_GRACE_PRESETS[2].value,
            description: recoveryGraceDescription(config),
        },
        {
            id: "summarizerIdleTimeoutMs",
            label: "Summarizer idle timeout",
            values: SUMMARIZER_IDLE_TIMEOUT_PRESETS.map((p) => p.value),
            currentValue: SUMMARIZER_IDLE_TIMEOUT_PRESETS.some((p) => p.value === String(config.summarizerIdleTimeoutMs))
                ? String(config.summarizerIdleTimeoutMs)
                : (SUMMARIZER_IDLE_TIMEOUT_PRESETS.find((p) => p.value === String(DEFAULT_CONFIG.summarizerIdleTimeoutMs))?.value ?? SUMMARIZER_IDLE_TIMEOUT_PRESETS[0].value), // fall back to the default preset if a custom value isn't in the cycle
            description: idleTimeoutDescription(config),
        },
        {
            id: "summarizerMaxTimeoutMs",
            label: "Summarizer max timeout",
            values: SUMMARIZER_MAX_TIMEOUT_PRESETS.map((p) => p.value),
            currentValue: SUMMARIZER_MAX_TIMEOUT_PRESETS.some((p) => p.value === String(config.summarizerMaxTimeoutMs))
                ? String(config.summarizerMaxTimeoutMs)
                : (SUMMARIZER_MAX_TIMEOUT_PRESETS.find((p) => p.value === String(DEFAULT_CONFIG.summarizerMaxTimeoutMs))?.value ?? SUMMARIZER_MAX_TIMEOUT_PRESETS[0].value), // fall back to the default preset if a custom value isn't in the cycle
            description: maxTimeoutDescription(config),
        },
        {
            id: "autoBudgetThreshold",
            label: "Auto-flush at context %",
            values: AUTO_BUDGET_PRESETS.map((p) => p.value),
            currentValue: (() => {
                const v = config.autoBudgetThreshold == null ? "0" : String(config.autoBudgetThreshold);
                return AUTO_BUDGET_PRESETS.some((p) => p.value === v) ? v : "0";
            })(),
            description: autoBudgetThresholdDescription(config),
        },
        {
            id: "dedupByContentHash",
            label: "Dedup by content hash",
            values: ["true", "false"],
            currentValue: String(config.dedupByContentHash),
            description: dedupByContentHashDescription(config),
        },
        {
            id: "chainCompressionEnabled",
            label: "Chain compression",
            values: ["true", "false"],
            currentValue: String(config.chainCompression.enabled),
            description: `Range-compress closed chains beyond the rolling window (K=${config.chainCompression.rollingWindow}). Drops middle assistant turns + tool results, injects a synthetic summary. Currently ${config.chainCompression.enabled ? "ON" : "OFF"}.`,
        },
        {
            id: "chainCompressionRollingWindow",
            label: "Chain window (K)",
            values: ROLLING_WINDOW_PRESETS.map((p) => p.value),
            // Fall back to the closest preset if the persisted value isn't in the cycle
            // (e.g. user hand-edited settings.json with a non-preset integer).
            currentValue: ROLLING_WINDOW_PRESETS.some((p) => p.value === String(config.chainCompression.rollingWindow))
                ? String(config.chainCompression.rollingWindow)
                : ROLLING_WINDOW_PRESETS[2].value,
            description: `Keep the K most-recently-closed chains raw; compress older ones. Currently ${config.chainCompression.rollingWindow}.`,
        },
        {
            id: "chainCompressionStripThinking",
            label: "Strip final thinking",
            values: ["true", "false"],
            currentValue: String(config.chainCompression.stripFinalAssistantThinking),
            description: `Strip thinking blocks from the kept final text-only assistant message when compressing a chain. Currently ${config.chainCompression.stripFinalAssistantThinking ? "ON" : "OFF"}.`,
        },
        {
            id: "chainCompressionFuseRange",
            label: "Fuse range summary",
            values: ["true", "false"],
            currentValue: String(config.chainCompression.fuseRangeSummary),
            description: `Fuse a compressed chain's per-batch summaries into one cohesive LLM summary (one extra summarizer call per multi-batch span). Off keeps the per-batch concatenation. Currently ${config.chainCompression.fuseRangeSummary ? "ON" : "OFF"}.`,
        },
        {
            id: "purgeErrorsEnabled",
            label: "Error purge",
            values: ["true", "false"],
            currentValue: String(config.purgeErrors.enabled),
            description: `Replace failed toolCall argument bodies with compact stubs after a cooldown. Reclaims context from large write/edit args that will never succeed. Currently ${config.purgeErrors.enabled ? "ON" : "OFF"}.`,
        },
        {
            id: "purgeErrorsCooldown",
            label: "Error purge cooldown (turns)",
            values: PURGE_COOLDOWN_PRESETS.map((p) => p.value),
            currentValue: PURGE_COOLDOWN_PRESETS.some((p) => p.value === String(config.purgeErrors.cooldownTurns))
                ? String(config.purgeErrors.cooldownTurns)
                : PURGE_COOLDOWN_PRESETS[1].value,
            description: `Wait this many turns after a tool error before purging its argument body. Currently ${config.purgeErrors.cooldownTurns}.`,
        },
        {
            id: "purgeErrorsMinArgChars",
            label: "Error purge min arg chars",
            values: PURGE_MIN_ARG_PRESETS.map((p) => p.value),
            currentValue: PURGE_MIN_ARG_PRESETS.some((p) => p.value === String(config.purgeErrors.minArgChars))
                ? String(config.purgeErrors.minArgChars)
                : PURGE_MIN_ARG_PRESETS[1].value,
            description: `Only purge arg bodies at least this many chars. Currently ${config.purgeErrors.minArgChars}.`,
        },
        {
            // Read-only display row. Editing goes through `/pruner protected-tools`
            // because SettingsList.submenu requires a synchronous Component,
            // while editing a free-form list needs `ctx.ui.input()` (async).
            id: "protectedTools",
            label: "Protected tools",
            values: [protectedToolsDisplay(config.protectedTools)],
            currentValue: protectedToolsDisplay(config.protectedTools),
            description: protectedToolsDescription(config),
        },
        {
            id: "protectedPaths",
            label: "Protected paths",
            values: [protectedToolsDisplay(config.protectedPaths)],
            currentValue: protectedToolsDisplay(config.protectedPaths),
            description: protectedPathsDescription(config),
        },
    ];
    let settingsList;
    let closeSettingsOverlay = () => { };
    const onChange = (id, newValue) => {
        // Read-only row — SettingsList still fires onChange when the user
        // presses Enter on a single-value item. Short-circuit so we don't
        // do a redundant saveConfig / status-widget refresh on no-op presses.
        if (id === "protectedTools" || id === "protectedPaths")
            return;
        const newConfig = { ...currentConfig.value };
        if (id === "enabled") {
            newConfig.enabled = newValue === "true";
        }
        else if (id === "showPruneStatusLine") {
            newConfig.showPruneStatusLine = newValue === "true";
            const statusLineItem = items.find((item) => item.id === "showPruneStatusLine");
            if (statusLineItem) {
                statusLineItem.description = pruneStatusLineDescription(newConfig);
            }
        }
        else if (id === "showOccStatusLine") {
            newConfig.showOccStatusLine = newValue === "true";
        }
        else if (id === "pruneOn") {
            newConfig.pruneOn = newValue;
            const pruneTriggerItem = items.find((item) => item.id === "pruneOn");
            if (pruneTriggerItem) {
                pruneTriggerItem.description = pruneTriggerDescription(newConfig.pruneOn);
            }
        }
        else if (id === "summarizerModel") {
            newConfig.summarizerModel = newValue;
        }
        else if (id === "summarizerThinking") {
            newConfig.summarizerThinking = newValue;
            const thinkingItem = items.find((item) => item.id === "summarizerThinking");
            if (thinkingItem) {
                thinkingItem.description = summarizerThinkingDescription(newConfig.summarizerThinking);
            }
        }
        else if (id === "batchingMode") {
            newConfig.batchingMode = newValue;
            const batchingItem = items.find((item) => item.id === "batchingMode");
            if (batchingItem) {
                batchingItem.description = batchingModeDescription(newConfig.batchingMode);
            }
        }
        else if (id === "quietOversizedSkips") {
            newConfig.quietOversizedSkips = newValue === "true";
            const quietItem = items.find((item) => item.id === "quietOversizedSkips");
            if (quietItem) {
                quietItem.description = quietOversizedSkipsDescription(newConfig);
            }
        }
        else if (id === "minBatchChars") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.minBatchChars = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.minBatchChars;
            const mbItem = items.find((item) => item.id === "minBatchChars");
            if (mbItem) {
                mbItem.description = minBatchCharsDescription(newConfig);
            }
        }
        else if (id === "recoveryGraceTurns") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.recoveryGraceTurns = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.recoveryGraceTurns;
            const rgItem = items.find((item) => item.id === "recoveryGraceTurns");
            if (rgItem) {
                rgItem.description = recoveryGraceDescription(newConfig);
            }
        }
        else if (id === "summarizerIdleTimeoutMs") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.summarizerIdleTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.summarizerIdleTimeoutMs;
            const it = items.find((item) => item.id === "summarizerIdleTimeoutMs");
            if (it)
                it.description = idleTimeoutDescription(newConfig);
        }
        else if (id === "summarizerMaxTimeoutMs") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.summarizerMaxTimeoutMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.summarizerMaxTimeoutMs;
            const it = items.find((item) => item.id === "summarizerMaxTimeoutMs");
            if (it)
                it.description = maxTimeoutDescription(newConfig);
        }
        else if (id === "autoBudgetThreshold") {
            const parsed = Number.parseFloat(newValue);
            newConfig.autoBudgetThreshold =
                Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : null;
            const abItem = items.find((item) => item.id === "autoBudgetThreshold");
            if (abItem) {
                abItem.description = autoBudgetThresholdDescription(newConfig);
            }
        }
        else if (id === "dedupByContentHash") {
            newConfig.dedupByContentHash = newValue === "true";
            const dedupItem = items.find((item) => item.id === "dedupByContentHash");
            if (dedupItem) {
                dedupItem.description = dedupByContentHashDescription(newConfig);
            }
        }
        else if (id === "chainCompressionEnabled") {
            newConfig.chainCompression = { ...newConfig.chainCompression, enabled: newValue === "true" };
        }
        else if (id === "chainCompressionRollingWindow") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.chainCompression = {
                ...newConfig.chainCompression,
                rollingWindow: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.chainCompression.rollingWindow,
            };
        }
        else if (id === "chainCompressionStripThinking") {
            newConfig.chainCompression = { ...newConfig.chainCompression, stripFinalAssistantThinking: newValue === "true" };
        }
        else if (id === "chainCompressionFuseRange") {
            newConfig.chainCompression = { ...newConfig.chainCompression, fuseRangeSummary: newValue === "true" };
        }
        else if (id === "purgeErrorsEnabled") {
            newConfig.purgeErrors = { ...newConfig.purgeErrors, enabled: newValue === "true" };
        }
        else if (id === "purgeErrorsCooldown") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.purgeErrors = {
                ...newConfig.purgeErrors,
                cooldownTurns: Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONFIG.purgeErrors.cooldownTurns,
            };
        }
        else if (id === "purgeErrorsMinArgChars") {
            const parsed = Number.parseInt(newValue, 10);
            newConfig.purgeErrors = {
                ...newConfig.purgeErrors,
                minArgChars: Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG.purgeErrors.minArgChars,
            };
        }
        currentConfig.value = newConfig;
        void persistConfig((m, t) => ctx.ui.notify(m, t), newConfig, save);
        refreshStatus(newConfig);
        settingsList?.invalidate();
    };
    settingsList = new SettingsList(items, 10, getSettingsListTheme(), onChange, () => closeSettingsOverlay(), // onCancel — close the custom overlay
    { enableSearch: false });
    // Use ctx.ui.custom() to show the settings list as an overlay.
    // The factory receives (tui, theme, keybindings, done) and returns a Component.
    // Wire Escape through the SettingsList constructor's onCancel callback instead
    // of mutating private SettingsList fields.
    await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
        closeSettingsOverlay = () => done(undefined);
        return new SettingsOverlay("pruner settings", settingsList);
    }, {
        overlay: true,
        overlayOptions: { width: 60 },
    });
}
