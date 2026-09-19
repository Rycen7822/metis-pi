import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { VoiceHelperClient } from "../helper.ts";
export declare function startRealtimeOffer(helper: VoiceHelperClient, config: CodexConversionConfig, mode: "native" | "bridge"): Promise<string>;
