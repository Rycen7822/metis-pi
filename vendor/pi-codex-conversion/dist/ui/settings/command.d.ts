import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { AdapterState } from "../../adapter/activation/state.ts";
export declare function registerCodexCommand(pi: ExtensionAPI, state: AdapterState, onConfigApplied?: (config: CodexConversionConfig, ctx: ExtensionContext, previousConfig: CodexConversionConfig) => void): void;
