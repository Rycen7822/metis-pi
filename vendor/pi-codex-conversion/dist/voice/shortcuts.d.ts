import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
export interface CodexVoiceShortcutActions {
    startDictation(ctx: ExtensionContext): Promise<void>;
    finishDictation(ctx: ExtensionContext): Promise<void>;
    toggleDictation(ctx: ExtensionContext): Promise<void>;
    toggleRealtime(ctx: ExtensionContext): Promise<void>;
    toggleInputMute(ctx: ExtensionContext): void;
    toggleServer(ctx: ExtensionContext): Promise<void>;
}
export declare function registerCodexVoiceShortcuts(pi: ExtensionAPI, initialConfig: CodexConversionConfig, getConfig: () => CodexConversionConfig, actions: CodexVoiceShortcutActions): void;
