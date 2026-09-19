import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, type SettingItem } from "@earendil-works/pi-tui";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
export interface ConfigSetting {
    item: SettingItem & {
        description: string;
    };
    update?: ((value: string, config: CodexConversionConfig) => CodexConversionConfig) | undefined;
    action?: "edit-config" | "global-luna-cache-keepalive" | "project-cache-keepalive" | undefined;
}
export declare class TextSettingSubmenu extends Container implements Focusable {
    private input;
    constructor(title: string, description: string, currentValue: string, onSubmit: (value: string) => void, onCancel: () => void, theme: Theme);
    get focused(): boolean;
    set focused(value: boolean);
    handleInput(data: string): void;
}
export declare function setting(item: ConfigSetting["item"], update?: ConfigSetting["update"]): ConfigSetting;
export declare function toggle(id: string, label: string, current: boolean, update: (enabled: boolean, config: CodexConversionConfig) => CodexConversionConfig, description: string): ConfigSetting;
export declare function projectCacheKeepalive(id: string, label: string, current: boolean): ConfigSetting;
