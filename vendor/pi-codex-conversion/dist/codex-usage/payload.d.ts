export interface CodexUsageWindow {
    usedPercent?: number | undefined;
    windowMinutes?: number | undefined;
    resetsAt?: number | undefined;
}
export interface CodexUsageLimit {
    limitId: string;
    limitName?: string | undefined;
    primary?: CodexUsageWindow | undefined;
    secondary?: CodexUsageWindow | undefined;
}
export interface CodexUsageSnapshot {
    planType?: string | undefined;
    limits: CodexUsageLimit[];
    resetCredits?: CodexRateLimitResetCredits | undefined;
    raw: unknown;
}
export interface CodexRateLimitResetCredit {
    id?: string | undefined;
    resetType?: string | undefined;
    status?: string | undefined;
    grantedAt?: string | undefined;
    expiresAt?: string | undefined;
    redeemStartedAt?: string | undefined;
    redeemedAt?: string | undefined;
    title?: string | undefined;
    description?: string | undefined;
}
export interface CodexRateLimitResetCredits {
    availableCount: number;
    credits: CodexRateLimitResetCredit[];
    raw: unknown;
}
export type CodexRateLimitResetConsumeOutcome = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit" | "unknown";
export interface CodexRateLimitResetConsumeResult {
    outcome: CodexRateLimitResetConsumeOutcome;
    windowsReset?: number | undefined;
    raw: unknown;
}
export declare function parseCodexRateLimitResetCreditsPayload(payload: unknown): CodexRateLimitResetCredits | undefined;
export declare function parseCodexUsagePayload(payload: unknown): CodexUsageSnapshot;
export declare function codexWeeklyUsageLeft(snapshot: CodexUsageSnapshot): number | undefined;
export declare function parseCodexRateLimitResetConsumePayload(payload: unknown): CodexRateLimitResetConsumeResult;
