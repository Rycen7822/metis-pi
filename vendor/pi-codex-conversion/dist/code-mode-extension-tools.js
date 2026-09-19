import { NOTEBOOK_MODE_TOOL_NAMES } from "./adapter/activation/tool-set.js";
import { codeModeGlobalName } from "./tools/code-mode/tool-identity.js";
const EXTENSION_TOOLS_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools/v1";
const EXTENSION_TOOLS_REFRESH_CHANNEL = "@howaboua/pi-codex-conversion.extension-code-mode-tools-refresh/v1";
const RESERVED_EXTENSION_TOOL_NAMES = new Set(NOTEBOOK_MODE_TOOL_NAMES);
export function registerCodeModeExtensionTools(pi, provider, options = {}) {
    let active = options.isActive === undefined;
    const stopProvider = pi.events.on(EXTENSION_TOOLS_CHANNEL, (value) => {
        if (!isExtensionToolsRequest(value))
            return;
        if (value.refreshGates)
            active = options.isActive?.(value.context) ?? true;
        value.add(provider, active);
    });
    const refresh = () => {
        pi.events.emit(EXTENSION_TOOLS_REFRESH_CHANNEL, undefined);
    };
    let registered = true;
    const unregister = () => {
        if (!registered)
            return;
        registered = false;
        stopProvider();
        refresh();
    };
    try {
        refresh();
    }
    catch (error) {
        registered = false;
        stopProvider();
        throw error;
    }
    return {
        refresh,
        unregister,
    };
}
export function onCodeModeExtensionToolsRefresh(pi, handler) {
    return pi.events.on(EXTENSION_TOOLS_REFRESH_CHANNEL, handler);
}
export function getCodeModeExtensionTools(pi, context) {
    return getCodeModeExtensionToolSnapshot(pi, context).tools;
}
export function getCodeModeExtensionToolSnapshot(pi, context, refreshGates = false) {
    const providers = [];
    pi.events.emit(EXTENSION_TOOLS_CHANNEL, {
        context,
        refreshGates,
        add(provider, active) {
            providers.push({ provider, active });
        },
    });
    const resolved = providers.map(({ provider, active }) => ({
        active,
        tools: provider(context),
    }));
    const allTools = resolved.flatMap(({ tools }) => tools);
    const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
    for (const tool of allTools) {
        if (RESERVED_EXTENSION_TOOL_NAMES.has(codeModeGlobalName(tool.name)))
            throw new Error(`Reserved Code Mode extension tool name: ${tool.name}`);
    }
    return {
        tools: resolved
            .filter(({ active }) => active)
            .flatMap(({ tools }) => tools)
            .filter((tool) => tool.topLevelName === undefined || registeredNames.has(tool.topLevelName)),
        allToolNames: [
            ...new Set(allTools.map((tool) => tool.topLevelName ?? tool.name)),
        ],
    };
}
function isExtensionToolsRequest(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "add" in value &&
        typeof value.add === "function" &&
        "refreshGates" in value &&
        typeof value.refreshGates === "boolean");
}
