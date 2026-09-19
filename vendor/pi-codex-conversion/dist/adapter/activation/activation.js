import { getCodeModeExtensionToolSnapshot } from "../../code-mode-extension-tools.js";
import { renderCodexStatus } from "../../ui/status.js";
import { ALL_CODEX_ADAPTER_TOOL_NAMES, isAdapterRuntime, resolveCodexRuntimePlanForState } from "./runtime-plan.js";
import { DEFAULT_TOOL_NAMES, STATUS_KEY, buildExtraToolsOnlyStatusText } from "./tool-set.js";
export function syncAdapter(pi, ctx, state) {
    state.availableToolNames = pi.getAllTools().map((tool) => tool.name);
    const plan = resolveCodexRuntimePlanForState(ctx, state);
    const extensionTools = state.enabled || plan.kind === "extras" || isAdapterRuntime(plan)
        ? getCodeModeExtensionToolSnapshot(pi, ctx, true)
        : { tools: [], allToolNames: [] };
    if (plan.kind === "extras")
        enableExtraTools(pi, ctx, state, plan, extensionTools);
    else if (isAdapterRuntime(plan))
        enableAdapter(pi, ctx, state, plan, extensionTools);
    else
        disableAdapter(pi, ctx, state, plan, extensionTools);
    return plan;
}
function enableExtraTools(pi, ctx, state, plan, extensionTools) {
    if (!state.enabled || !sameToolSet(state.adapterOwnedToolNames ?? [], plan.toolNames)) {
        state.previousToolNames = state.enabled
            ? restoreTools(state.previousToolNames?.length ? state.previousToolNames : DEFAULT_TOOL_NAMES, pi.getActiveTools(), state.adapterOwnedToolNames ?? ALL_CODEX_ADAPTER_TOOL_NAMES)
            : stripAdapterTools(pi.getActiveTools(), ALL_CODEX_ADAPTER_TOOL_NAMES);
        state.enabled = true;
    }
    reconcileExtensionToolProjection(state, pi.getActiveTools(), extensionTools);
    state.adapterOwnedToolNames = plan.toolNames;
    setActiveTools(pi, mergeToolNames(state.previousToolNames ?? DEFAULT_TOOL_NAMES, plan.toolNames));
    if (ctx.hasUI)
        ctx.ui.setStatus(STATUS_KEY, !state.config.voiceFeaturesOnly && state.config.ui.statusLine ? buildExtraToolsOnlyStatusText(plan.toolNames, ctx.ui.theme) : undefined);
}
function enableAdapter(pi, ctx, state, plan, extensionTools) {
    const owned = state.enabled ? mergeToolNames(state.adapterOwnedToolNames ?? plan.ownedToolNames, plan.ownedToolNames) : plan.ownedToolNames;
    if (!state.enabled) {
        state.previousToolNames = stripAdapterTools(pi.getActiveTools(), owned);
        state.enabled = true;
    }
    const projectedTools = reconcileExtensionToolProjection(state, pi.getActiveTools(), extensionTools);
    const activeTools = plan.kind === "normal"
        ? restoreTools(state.previousToolNames ?? [], projectedTools, owned)
        : projectedTools;
    const tools = mergeAdapterTools(activeTools, plan.toolNames, owned);
    state.adapterOwnedToolNames = plan.ownedToolNames;
    setActiveTools(pi, tools);
    renderCodexStatus(ctx, state, plan);
}
function disableAdapter(pi, ctx, state, plan, extensionTools) {
    const owned = state.adapterOwnedToolNames ?? plan.ownedToolNames;
    if (state.enabled || (!(plan.kind === "inactive" && plan.missingToolNames) && pi.getActiveTools().some((name) => owned.includes(name)))) {
        const currentTools = state.enabled
            ? reconcileExtensionToolProjection(state, pi.getActiveTools(), extensionTools)
            : pi.getActiveTools();
        const previous = state.previousToolNames?.length
            ? state.previousToolNames
            : DEFAULT_TOOL_NAMES;
        setActiveTools(pi, restoreTools(previous, currentTools, owned));
    }
    state.enabled = false;
    delete state.adapterOwnedToolNames;
    delete state.codeModeExtensionToolNames;
    if (ctx.hasUI)
        ctx.ui.setStatus(STATUS_KEY, plan.kind === "inactive" && plan.missingToolNames
            ? `Codex adapter off: unavailable tools (${plan.missingToolNames.join(", ")}); check tool allowlist`
            : undefined);
}
function reconcileExtensionToolProjection(state, currentTools, extensionTools) {
    const previousTools = state.previousToolNames ?? [];
    const managedNames = new Set(extensionTools.allToolNames);
    const previousManagedNames = state.codeModeExtensionToolNames ?? [];
    const releasedActiveNames = previousManagedNames.filter((name) => !managedNames.has(name) && previousTools.includes(name));
    const activeNames = new Set(extensionTools.tools.map((tool) => tool.topLevelName ?? tool.name));
    state.previousToolNames = previousTools.filter((name) => !managedNames.has(name) || activeNames.has(name));
    for (const name of activeNames) {
        if (!state.previousToolNames.includes(name))
            state.previousToolNames.push(name);
    }
    state.codeModeExtensionToolNames = extensionTools.allToolNames;
    return mergeToolNames(currentTools, releasedActiveNames).filter((name) => !managedNames.has(name));
}
function mergeToolNames(...groups) {
    return [...new Set(groups.flat())];
}
function setActiveTools(pi, toolNames) {
    const current = pi.getActiveTools();
    if (current.length !== toolNames.length ||
        current.some((name, index) => name !== toolNames[index]))
        pi.setActiveTools(toolNames);
}
export function mergeAdapterTools(activeTools, adapterTools, adapterOwnedTools = adapterTools) {
    const owned = new Set([...adapterTools, ...adapterOwnedTools]);
    const preserved = activeTools.filter((name) => !DEFAULT_TOOL_NAMES.includes(name) && !owned.has(name));
    return [...adapterTools, ...preserved];
}
export function restoreTools(previousTools, activeTools, adapterOwnedTools = ALL_CODEX_ADAPTER_TOOL_NAMES) {
    const restored = stripAdapterTools(previousTools, adapterOwnedTools);
    for (const name of activeTools)
        if (!adapterOwnedTools.includes(name) && !restored.includes(name))
            restored.push(name);
    return restored;
}
export function stripAdapterTools(toolNames, adapterOwnedTools = ALL_CODEX_ADAPTER_TOOL_NAMES) {
    return toolNames.filter((name) => !adapterOwnedTools.includes(name));
}
function sameToolSet(left, right) {
    return left.length === right.length && left.every((name) => right.includes(name));
}
