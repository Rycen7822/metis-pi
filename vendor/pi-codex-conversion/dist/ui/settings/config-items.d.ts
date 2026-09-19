import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig, VoiceContextModel } from "../../adapter/activation/config.ts";
import type { ConfigSetting } from "./config-items-shared.ts";
import type { SettingsTab } from "./tabs.ts";
export type { ConfigSetting } from "./config-items-shared.ts";
export declare function buildConfigSettings(tab: SettingsTab, config: CodexConversionConfig, theme: Theme, availableContextModels?: VoiceContextModel[]): ConfigSetting[];
