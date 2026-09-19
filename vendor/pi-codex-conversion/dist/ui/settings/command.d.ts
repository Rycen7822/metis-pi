import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { AdapterState } from "../../adapter/activation/state.ts";
import type { CodexVoiceController } from "../../voice/controller.ts";
import type { CodexLanVoiceServerController } from "../../voice/lan/controller.ts";
export declare function registerCodexCommand(pi: ExtensionAPI, state: AdapterState, voice: CodexVoiceController, lanVoice: CodexLanVoiceServerController, onConfigApplied?: (config: CodexConversionConfig, ctx: ExtensionContext, previousConfig: CodexConversionConfig) => void): void;
