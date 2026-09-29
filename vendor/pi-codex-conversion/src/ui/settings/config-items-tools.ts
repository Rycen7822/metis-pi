import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import { type ConfigSetting, configToggle } from "./config-items-shared.ts";

export function buildToolsSettings(
	config: CodexConversionConfig,
): ConfigSetting[] {
	return [
		configToggle(config, "tools", "autoReasoning", "Auto reasoning (GPT-6)",
			"Let GPT-6 adjust reasoning during a task, never below your starting level, then restore it when finished."),
		configToggle(config, "tools", "viewImageFallback", "Image descriptions fallback",
			"Use a vision model to describe images for text-only models instead of rejecting image requests."),
		configToggle(config, "tools", "plainCommandOutput", "Plain command output",
			"In Code mode, send shell output without JSON escaping, keeping command status and continuation details."),
		configToggle(config, "tools", "applyPatchOnly", "Standalone apply_patch",
			"Expose apply_patch without the full adapter."),
		configToggle(config, "tools", "viewImageOnly", "Standalone view_image",
			"Expose view_image without the full adapter. Text-only models also need Image descriptions fallback."),
	];
}
