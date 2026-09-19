import type { CodexUsageLimit, CodexUsageSnapshot } from "./payload.ts";
export declare const CODEX_RESERVE_USAGE_NOTE = "Luna Reserve: separate, limited allowance after ordinary quota runs out; availability is backend-controlled.";
export declare function codexUsageLimitName(limit: CodexUsageLimit): string;
export declare function formatCodexUsage(snapshot: CodexUsageSnapshot): string;
