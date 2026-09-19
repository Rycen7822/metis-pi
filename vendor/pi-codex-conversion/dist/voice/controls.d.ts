import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../adapter/activation/state.ts";
import type { CodexVoiceController } from "./controller.ts";
import type { CodexLanVoiceServerController } from "./lan/controller.ts";
import { type CodexVoiceMode } from "./ui.ts";
export interface CodexVoiceControls {
    setup(ctx: ExtensionContext): Promise<void>;
    start(mode: CodexVoiceMode, ctx: ExtensionContext): Promise<void>;
    stop(ctx: ExtensionContext): Promise<void>;
    toggleInputMute(ctx: ExtensionContext): void;
}
export declare function createCodexVoiceControls(options: {
    pi: ExtensionAPI;
    state: AdapterState;
    voice: CodexVoiceController;
    lanVoice: CodexLanVoiceServerController;
}): CodexVoiceControls;
