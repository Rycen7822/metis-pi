import { STATUS_KEY, buildStatusText } from "../adapter/activation/tool-set.js";
import { isResponsesContext } from "../adapter/prompt/codex-model.js";
export function renderCodexStatus(ctx, state, plan) {
    if (!ctx.hasUI)
        return;
    if (!state.config.ui.statusLine) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
    }
    const config = state.config;
    ctx.ui.setStatus(STATUS_KEY, buildStatusText({
        mode: plan.kind,
        useOnAllModels: config.scope.allProviders === "on",
        additionalProvider: plan.configuredProvider,
        fast: plan.effectiveOpenAICodex && config.openai.fast,
        contextManagement: plan.contextManagementMode,
        compaction: plan.nativeCompaction,
        weeklyUsageLeft: state.weeklyUsageLeft,
        ...(isResponsesContext(ctx) ? { verbosity: config.openai.verbosity } : {}),
    }, ctx.ui.theme));
}
