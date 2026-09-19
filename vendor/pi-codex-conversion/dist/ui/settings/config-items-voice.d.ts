import { type CodexConversionConfig, type VoiceContextModel } from "../../adapter/activation/config.ts";
import { type ConfigSetting } from "./config-items-shared.ts";
export declare function buildVoiceSettings(config: CodexConversionConfig, availableContextModels: VoiceContextModel[]): ConfigSetting[];
