import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig, LunaCacheKeepaliveMinutes } from "../../adapter/activation/config.ts";
import type { CodexConversionConfigScope } from "../../adapter/activation/config-store.ts";
import type { CodexLanVoiceServerStatus } from "../../voice/lan/controller.ts";
import { type SettingsTab } from "./tabs.ts";
import { type UsageTabOptions } from "./usage-tab.ts";
export interface CodexSettingsScreenOptions extends UsageTabOptions {
    initialConfig: CodexConversionConfig;
    onChange: (nextConfig: CodexConversionConfig) => boolean;
    onGlobalLunaCacheKeepalive: (minutes: LunaCacheKeepaliveMinutes) => CodexConversionConfig | undefined;
    onProjectCacheKeepalive: (enabled: boolean) => CodexConversionConfig | undefined;
    initialTab?: SettingsTab | undefined;
    configScope: {
        current: () => CodexConversionConfigScope;
        canUseFolder: boolean;
        path: () => string;
        reload: () => CodexConversionConfig;
        set: (scope: CodexConversionConfigScope) => CodexConversionConfig | undefined;
    };
    lanVoiceServer?: {
        status: () => CodexLanVoiceServerStatus;
        setEnabled: (enabled: boolean) => Promise<CodexLanVoiceServerStatus>;
    } | undefined;
}
export declare function openCodexSettingsScreen(ctx: ExtensionContext, options: CodexSettingsScreenOptions): Promise<void>;
