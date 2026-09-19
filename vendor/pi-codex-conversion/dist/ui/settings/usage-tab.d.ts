import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { CodexRateLimitResetConsumeResult, CodexUsageSnapshot } from "../../codex-usage/payload.ts";
export interface UsageTabOptions {
    initialUsage?: CodexUsageSnapshot | {
        error: string;
    } | undefined;
    onRefreshUsage?: (() => Promise<CodexUsageSnapshot>) | undefined;
    onConsumeResetCredit?: ((redeemRequestId: string) => Promise<CodexRateLimitResetConsumeResult>) | undefined;
}
export interface UsageTabController {
    ensureLoaded(): void;
    handleInput(data: string): boolean;
    render(theme: Theme): string[];
}
export declare function createUsageTab(ctx: ExtensionContext, options: UsageTabOptions, requestRender: () => void): UsageTabController;
