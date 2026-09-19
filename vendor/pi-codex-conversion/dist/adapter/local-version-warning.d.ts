import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare function isLocalCheckoutPath(path: string): boolean;
export declare function compareSemverLike(left: string, right: string): number;
export declare function formatLocalCheckoutUpdateWarning(currentVersion: string, latestVersion: string): string;
export declare function maybeWarnLocalCheckoutVersion(ctx: ExtensionContext, options?: {
    packageRoot?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
}): Promise<void>;
