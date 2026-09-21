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
type ConfigSection = Exclude<keyof CodexConversionConfig, "executionMode" | "voiceFeaturesOnly">;
type BooleanKey<T> = {
    [K in keyof T]-?: T[K] extends boolean ? K : never;
}[keyof T] & string;
/** A single-field toggle reads the displayed snapshot but updates the latest draft. */
export declare function configToggle<S extends ConfigSection>(config: CodexConversionConfig, section: S, key: BooleanKey<CodexConversionConfig[S]>, label: string, description: string, id?: string): ConfigSetting;
export declare function projectCacheKeepalive(id: string, label: string, current: boolean): ConfigSetting;
export {};
