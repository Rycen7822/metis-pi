import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { CodexExtensionRuntime } from "./runtime.ts";
export interface CodexUiController {
    clearBackgroundWidget(): void;
    invalidateBackgroundWidget(): void;
    renderBackgroundWidget(): void;
    invalidateUsageStatus(): void;
    applyConfig(config: CodexConversionConfig, ctx: ExtensionContext, previousConfig: CodexConversionConfig): void;
    refreshUsageStatus(ctx: ExtensionContext): Promise<void>;
}
export declare function registerCodexUi(pi: ExtensionAPI, runtime: CodexExtensionRuntime): CodexUiController;
