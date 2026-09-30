import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../../config/config.ts";
import { buildAdapterSettings } from "./config-items-adapter.ts";
import { buildContextSettings } from "./config-items-context.ts";
import { buildDisplaySettings } from "./config-items-display.ts";
import { buildOpenAISettings } from "./config-items-openai.ts";
import type { ConfigSetting } from "./config-items-shared.ts";
import { buildToolsSettings } from "./config-items-tools.ts";
import type { SettingsTab } from "./tabs.ts";

export type { ConfigSetting } from "./config-items-shared.ts";

export function buildConfigSettings(
	tab: SettingsTab,
	config: CodexConversionConfig,
	theme: Theme,
): ConfigSetting[] {
	if (tab === "adapter") return buildAdapterSettings(config, theme);
	if (tab === "context") return buildContextSettings(config);
	if (tab === "tools") return buildToolsSettings(config);
	if (tab === "openai") return buildOpenAISettings(config);
	if (tab === "display") return buildDisplaySettings(config);
	return [];
}
