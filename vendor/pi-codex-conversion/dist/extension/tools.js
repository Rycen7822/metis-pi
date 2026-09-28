import { runExecFusionCommand } from "../tools/action-fusion-command.js";
import { isActionFusionEnabled } from "../tools/action-fusion-availability.js";
import { registerCodexToolProviderPolicy, registerCodexToolProviderResolver, resolveCodexToolProvider, } from "../adapter/codex-tool-provider.js";
import { isResponsesModel } from "../adapter/prompt/codex-model.js";
import { registerApplyPatchResultEvent, registerApplyPatchTool, } from "../tools/apply-patch/tool.js";
import { registerExecCommandTool } from "../tools/exec/command-tool.js";
import { registerWriteStdinTool } from "../tools/exec/write-stdin-tool.js";
import { registerViewImageTool } from "../tools/view-image/tool.js";
import { registerContextManagementTools } from "../context-management/tools.js";
export function isExplicitlyConfiguredToolProvider(model, config) {
    const provider = model?.provider?.trim().toLowerCase();
    return Boolean(isResponsesModel(model) &&
        provider &&
        config.scope.additionalProviders.some((entry) => entry.trim().toLowerCase() === provider));
}
export function registerCodexTools(pi, runtime) {
    registerApplyPatchResultEvent(pi);
    pi.registerTool(runtime.autoReasoning.tool);
    registerContextManagementTools(pi, runtime.state);
    const allowsProvider = (model) => isExplicitlyConfiguredToolProvider(model, runtime.state.config);
    const unregisterProviderPolicy = registerCodexToolProviderPolicy(pi, (model) => allowsProvider(model));
    const unregisterProviderResolver = registerCodexToolProviderResolver(pi, (ctx) => resolveCodexToolProvider(ctx, (model) => allowsProvider(model)));
    const renderOptions = (config) => ({
        customRendering: config.ui.toolRenaming,
    });
    const registerCore = (config) => {
        registerApplyPatchTool(pi, {
            runThenRun: isActionFusionEnabled(pi)
                ? (ctx) => (input, signal, update) => runExecFusionCommand(runtime.sessions, input, ctx, signal, update)
                : undefined,
            customRustBinariesDir: config.tools.customRustBinariesDir,
            showDiffWhenCollapsed: config.ui.compactTools === "off",
        });
        registerExecCommandTool(pi, runtime.tracker, runtime.sessions, {
            ...renderOptions(config),
            showOutputWhenCollapsed: true,
        });
        registerWriteStdinTool(pi, runtime.sessions, {
            showOutputWhenCollapsed: true,
        });
        registerViewImageTool(pi, {
            customRustBinariesDir: config.tools.customRustBinariesDir,
            describeForTextModels: config.tools.viewImageFallback,
            ...renderOptions(config),
        });
    };
    registerCore(runtime.state.config);
    // All entry factories have completed by session_start, regardless of order.
    pi.on("session_start", () => {
        registerCore(runtime.state.config);
    });
    return {
        applyConfig(config) {
            registerCore(config);
            runtime.sessions.setBaseEnv(runtime.execEnv(config));
        },
        shutdown() {
            unregisterProviderResolver();
            unregisterProviderPolicy();
        },
    };
}
