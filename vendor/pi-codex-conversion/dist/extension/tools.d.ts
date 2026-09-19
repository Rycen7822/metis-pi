import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { CodexExtensionRuntime } from "./runtime.ts";
export interface CodexToolRegistration {
    applyConfig(config: CodexConversionConfig): void;
    shutdown(): void;
}
export declare function isExplicitlyConfiguredToolProvider(model: Model<Api> | undefined, config: CodexConversionConfig): boolean;
export declare function registerCodexTools(pi: ExtensionAPI, runtime: CodexExtensionRuntime): CodexToolRegistration;
