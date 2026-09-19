import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { isAdapterRuntime, resolveCodexRuntimePlanForState } from "../adapter/activation/runtime-plan.js";
import { NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, NATIVE_COMPACTION_DISPLAY_TEXT } from "../adapter/compaction/types.js";
import { fetchCodexWeeklyUsageLeft } from "../codex-usage/client.js";
import { CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, isCodexContextManagementMessageDetails, } from "../context-management/messages.js";
import { renderContextWindowBoundary } from "../context-management/rendering.js";
import { BACKGROUND_BASH_WIDGET_ID, registerBackgroundBashWidgetShortcuts, renderBackgroundBashWidget } from "../ui/background-bash-widget.js";
import { renderCodexStatus } from "../ui/status.js";
export function registerCodexUi(pi, runtime) {
    let renderTimer;
    let backgroundWidgetGeneration = 0;
    let usageGeneration = 0;
    const cancelScheduledBackgroundRender = () => {
        backgroundWidgetGeneration += 1;
        if (renderTimer)
            clearTimeout(renderTimer);
        renderTimer = undefined;
    };
    const clearBackgroundWidget = () => {
        cancelScheduledBackgroundRender();
        runtime.backgroundWidget.ctx?.ui.setWidget(BACKGROUND_BASH_WIDGET_ID, undefined);
    };
    const invalidateBackgroundWidget = () => {
        cancelScheduledBackgroundRender();
        const ctx = runtime.backgroundWidget.ctx;
        runtime.backgroundWidget.ctx = undefined;
        ctx?.ui.setWidget(BACKGROUND_BASH_WIDGET_ID, undefined);
    };
    const renderBackgroundWidget = (generation = backgroundWidgetGeneration) => {
        if (generation !== backgroundWidgetGeneration)
            return;
        const ctx = runtime.backgroundWidget.ctx;
        if (!ctx)
            return;
        if (runtime.state.config.voiceFeaturesOnly || !runtime.state.config.ui.backgroundShellWidget) {
            clearBackgroundWidget();
            return;
        }
        renderBackgroundBashWidget(ctx, runtime.backgroundWidget, runtime.sessions);
    };
    registerBackgroundBashWidgetShortcuts(pi, runtime.backgroundWidget, runtime.sessions, runtime.state.config.ui, () => !runtime.state.config.voiceFeaturesOnly && runtime.state.config.ui.backgroundShellWidget);
    const renderNativeCompaction = (content, kind, theme) => {
        if (kind === "usage")
            return new Text(theme.fg("dim", `  ${content}`), 0, 0);
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
        box.addChild(new Text(`\n${theme.fg("customMessageText", content)}`, 0, 0));
        const render = box.render.bind(box);
        box.render = (width) => render(width).map((line) => truncateToWidth(line, width, ""));
        return box;
    };
    pi.registerMessageRenderer(CODEX_CONTEXT_WINDOW_MESSAGE_TYPE, (message, { expanded }, theme) => {
        if (!isCodexContextManagementMessageDetails(message.details) ||
            message.details.contextManagement.kind !== "window" ||
            typeof message.content !== "string")
            return undefined;
        return renderContextWindowBoundary(message.details, expanded, theme);
    });
    // Legacy sessions stored display-only compaction records as custom messages.
    pi.registerMessageRenderer(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, (message, _options, theme) => {
        const content = typeof message.content === "string" ? message.content : NATIVE_COMPACTION_DISPLAY_TEXT;
        return renderNativeCompaction(content, message.details?.kind, theme);
    });
    pi.registerEntryRenderer(NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE, (entry, _options, theme) => {
        return renderNativeCompaction(typeof entry.data?.content === "string" ? entry.data.content : NATIVE_COMPACTION_DISPLAY_TEXT, entry.data?.kind, theme);
    });
    runtime.sessions.onSessionChange((reason) => {
        if (!runtime.backgroundWidget.ctx || runtime.state.config.voiceFeaturesOnly || !runtime.state.config.ui.backgroundShellWidget)
            return;
        if (reason === "output") {
            if (renderTimer)
                return;
            const generation = backgroundWidgetGeneration;
            renderTimer = setTimeout(() => {
                renderTimer = undefined;
                renderBackgroundWidget(generation);
            }, 250);
            return;
        }
        cancelScheduledBackgroundRender();
        renderBackgroundWidget();
    });
    const invalidateUsageStatus = () => {
        usageGeneration += 1;
        runtime.state.weeklyUsageLeft = undefined;
    };
    const refreshUsageStatus = async (ctx) => {
        const generation = ++usageGeneration;
        if (!ctx.hasUI || runtime.state.config.voiceFeaturesOnly || !runtime.state.config.ui.statusLine) {
            runtime.state.weeklyUsageLeft = undefined;
            return;
        }
        if (!isAdapterRuntime(resolveCodexRuntimePlanForState(ctx, runtime.state)))
            return;
        const weeklyUsageLeft = await fetchCodexWeeklyUsageLeft(ctx);
        const plan = resolveCodexRuntimePlanForState(ctx, runtime.state);
        if (generation !== usageGeneration ||
            !ctx.hasUI ||
            runtime.state.config.voiceFeaturesOnly ||
            !runtime.state.config.ui.statusLine ||
            !isAdapterRuntime(plan))
            return;
        runtime.state.weeklyUsageLeft = weeklyUsageLeft;
        renderCodexStatus(ctx, runtime.state, plan);
    };
    return {
        clearBackgroundWidget,
        invalidateBackgroundWidget,
        renderBackgroundWidget,
        invalidateUsageStatus,
        refreshUsageStatus,
        applyConfig(config, ctx, previousConfig) {
            if (config.voiceFeaturesOnly || !config.ui.statusLine) {
                invalidateUsageStatus();
            }
            else if (previousConfig.voiceFeaturesOnly ||
                !previousConfig.ui.statusLine) {
                void refreshUsageStatus(ctx);
            }
            if (config.voiceFeaturesOnly || !config.ui.backgroundShellWidget)
                clearBackgroundWidget();
            else
                renderBackgroundWidget();
        },
    };
}
