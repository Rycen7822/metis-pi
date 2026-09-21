import { normalizeCompactToolsMode } from "../../adapter/activation/config.js";
import { configToggle, setting } from "./config-items-shared.js";
export function buildDisplaySettings(config) {
    return [
        configToggle(config, "ui", "statusLine", "Statusline", "Show the adapter mode, context settings and available Codex usage information in Pi's status area."),
        configToggle(config, "ui", "toolRenaming", "Tool naming", "Rename tool calls to user-friendly names."),
        setting({
            id: "compactTools",
            label: "Compact tool output",
            currentValue: config.ui.compactTools,
            values: ["off", "on", "minimal"],
            description: "On hides collapsed patch diffs. Minimal also replaces Code / Notebook text previews with an expand hint; nested tool output stays visible.",
        }, (value, current) => ({
            ...current,
            ui: { ...current.ui, compactTools: normalizeCompactToolsMode(value) ?? current.ui.compactTools },
        })),
        configToggle(config, "ui", "codeModeDetails", "Code / Notebook details", "Show Code and Notebook source previews and execution output alongside nested tool results."),
        configToggle(config, "ui", "backgroundShellWidget", "Background shells widget", "Show tracked background shell sessions and their status above the editor."),
    ];
}
