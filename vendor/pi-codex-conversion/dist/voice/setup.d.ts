import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { CodexVoiceMode } from "./ui.ts";
export declare function formatVoiceAudioError(error: Error, mode: CodexVoiceMode, config: CodexConversionConfig): string;
export declare function buildVoiceSetupInstructions(options: {
    config: CodexConversionConfig;
    configPath: string;
    helperPath: string | undefined;
    retryCommand: string;
}): string;
export declare function formatVoiceShortcut(value: string): string;
