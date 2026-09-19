import { normalizeProviderList, } from "../../adapter/activation/config.js";
import { editorCommand } from "./config-editor.js";
import { setting, TextSettingSubmenu, } from "./config-items-shared.js";
export function buildAdapterSettings(config, theme) {
    return [
        setting({
            id: "extensionMode",
            description: "Voice only disables the prompt and tool adapter. Standalone tools remain controlled by Provider scope.",
            label: "Extension mode",
            currentValue: config.voiceFeaturesOnly
                ? "voice only"
                : "adapter and voice",
            values: ["adapter and voice", "voice only"],
        }, (value, current) => ({
            ...current,
            voiceFeaturesOnly: value === "voice only",
        })),
        setting({
            id: "allProviders",
            description: "Choose which models use the adapter. Extra tools only exposes standalone tools without replacing the prompt.",
            label: "Provider scope",
            currentValue: formatAllProvidersMode(config.scope.allProviders),
            values: ["Codex and configured", "all providers", "extra tools only"],
        }, (value, current) => ({
            ...current,
            scope: {
                ...current.scope,
                allProviders: parseAllProvidersMode(value),
            },
        })),
        setting({
            id: "additionalProviders",
            description: "Provider IDs for compatible Responses endpoints, including passthrough proxies, that should use the adapter.",
            label: "Additional providers",
            currentValue: config.scope.additionalProviders.join(", "),
            submenu: (currentValue, done) => new TextSettingSubmenu("Additional providers", "Comma-separated provider ids that should use the adapter.", currentValue, (value) => done(normalizeCodexProviderText(value)), () => done(), theme),
        }, (value, current) => ({
            ...current,
            scope: {
                ...current.scope,
                additionalProviders: normalizeProviderList(value.split(",")),
            },
        })),
        setting({
            id: "heavySystemPromptOverwrite",
            description: "Remove generic instructions from the system prompt.",
            label: "Heavy system prompt overwrite",
            currentValue: config.prompt.heavySystemPromptOverwrite
                ? "on (40% smaller)"
                : "off",
            values: ["off", "on (40% smaller)"],
        }, (value, current) => ({
            ...current,
            prompt: {
                ...current.prompt,
                heavySystemPromptOverwrite: value !== "off",
            },
        })),
        {
            item: {
                id: "editConfig",
                description: "Open the selected scope's config file in your editor for settings not exposed here.",
                label: "Edit config",
                currentValue: editorCommand()
                    ? "Opens in default editor (please /reload)"
                    : "Set $EDITOR",
                values: editorCommand() ? ["Open"] : ["Unavailable"],
            },
            action: "edit-config",
        },
    ];
}
function formatAllProvidersMode(value) {
    if (value === "on")
        return "all providers";
    if (value === "extras")
        return "extra tools only";
    return "Codex and configured";
}
function parseAllProvidersMode(value) {
    if (value === "all providers")
        return "on";
    if (value === "extra tools only")
        return "extras";
    return "off";
}
function normalizeCodexProviderText(value) {
    return normalizeProviderList(value.split(",")).join(", ");
}
