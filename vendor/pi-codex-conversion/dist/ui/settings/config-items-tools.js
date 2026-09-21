import { configToggle } from "./config-items-shared.js";
export function buildToolsSettings(config) {
    return [
        configToggle(config, "tools", "autoReasoning", "Auto reasoning (Astra only)", "Let Astra adjust reasoning during a task, never below your starting level, then restore it when finished."),
        configToggle(config, "tools", "viewImageFallback", "Image descriptions fallback", "Use a vision model to describe images for text-only models instead of rejecting image requests."),
        configToggle(config, "notebook", "plainCommandOutput", "Plain command output", "In Code and Notebook modes, send shell output without JSON escaping, keeping command status and continuation details.", "notebookPlainCommandOutput"),
        configToggle(config, "tools", "applyPatchOnly", "Standalone apply_patch", "Expose apply_patch without the full adapter."),
        configToggle(config, "tools", "viewImageOnly", "Standalone view_image", "Expose view_image without the full adapter. Text-only models also need Image descriptions fallback."),
    ];
}
