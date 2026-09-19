import type { CodexConversionConfig } from "./config.ts";
export type CodexCacheKeepaliveStrategy = "generated-current";
export interface CodexCacheKeepalivePlan {
    strategy: CodexCacheKeepaliveStrategy;
    intervalMs: number;
    maxOperations?: number | undefined;
}
export declare const LUNA_CACHE_KEEPALIVE_INTERVAL_MS: number;
export declare const SOL_TERRA_CACHE_KEEPALIVE_INTERVAL_MS: number;
export declare function resolveCodexCacheKeepalivePlan(modelId: string | undefined, config: Pick<CodexConversionConfig["openai"], "cacheKeepalive" | "lunaCacheKeepaliveMinutes">): CodexCacheKeepalivePlan | undefined;
export declare function hasCodexCacheKeepalivePlanChanged(modelId: string | undefined, previous: CodexConversionConfig["openai"], next: CodexConversionConfig["openai"]): boolean;
