const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function integerValue(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return Math.max(0, Math.trunc(value));
    if (typeof value !== "string" || value.trim().length === 0)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
}
function parseResetCredit(value) {
    if (!isRecord(value))
        return undefined;
    return {
        id: stringValue(value["id"]),
        resetType: stringValue(value["reset_type"]),
        status: stringValue(value["status"]),
        grantedAt: stringValue(value["granted_at"]),
        expiresAt: stringValue(value["expires_at"]),
        redeemStartedAt: stringValue(value["redeem_started_at"]),
        redeemedAt: stringValue(value["redeemed_at"]),
        title: stringValue(value["title"]),
        description: stringValue(value["description"]),
    };
}
export function parseCodexRateLimitResetCreditsPayload(payload) {
    const root = isRecord(payload) ? payload : undefined;
    if (!root)
        return undefined;
    const availableCount = integerValue(root["available_count"]);
    if (availableCount === undefined)
        return undefined;
    const credits = Array.isArray(root["credits"]) ? root["credits"].map(parseResetCredit).filter((credit) => Boolean(credit)) : [];
    return { availableCount, credits, raw: payload };
}
function parseCodexRateLimitResetCreditsSummary(value) {
    if (!isRecord(value))
        return undefined;
    const availableCount = integerValue(value["available_count"]);
    return availableCount === undefined ? undefined : { availableCount, credits: [], raw: value };
}
function parseWindow(value) {
    if (!isRecord(value))
        return undefined;
    const usedPercent = numberValue(value["used_percent"]);
    const limitWindowSeconds = numberValue(value["limit_window_seconds"]);
    const windowMinutes = numberValue(value["window_minutes"]) ?? (limitWindowSeconds === undefined ? undefined : Math.ceil(limitWindowSeconds / 60));
    const resetsAt = numberValue(value["resets_at"]) ?? numberValue(value["reset_at"]);
    return usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined ? undefined : { usedPercent, windowMinutes, resetsAt };
}
function parseRateLimit(value) {
    if (!isRecord(value))
        return {};
    const primary = parseWindow(value["primary_window"]) ?? parseWindow(value["primary"]);
    const secondary = parseWindow(value["secondary_window"]) ?? parseWindow(value["secondary"]);
    if (primary?.windowMinutes === WEEKLY_WINDOW_MINUTES && !secondary)
        return { secondary: primary };
    return { primary, secondary };
}
export function parseCodexUsagePayload(payload) {
    const root = isRecord(payload) ? payload : {};
    const limits = [];
    const addLimit = (limitId, limitName, source) => {
        const rateLimit = isRecord(source) && "rate_limit" in source ? source["rate_limit"] : source;
        const parsed = parseRateLimit(rateLimit);
        limits.push({
            limitId,
            ...(limitName ? { limitName } : {}),
            ...(parsed.primary ? { primary: parsed.primary } : {}),
            ...(parsed.secondary ? { secondary: parsed.secondary } : {}),
        });
    };
    addLimit("codex", undefined, root["rate_limit"]);
    if (Array.isArray(root["additional_rate_limits"])) {
        for (const item of root["additional_rate_limits"]) {
            if (!isRecord(item))
                continue;
            addLimit(stringValue(item["metered_feature"]) ?? "additional", stringValue(item["limit_name"]), item);
        }
    }
    return { planType: stringValue(root["plan_type"]), limits, resetCredits: parseCodexRateLimitResetCreditsSummary(root["rate_limit_reset_credits"]), raw: payload };
}
export function codexWeeklyUsageLeft(snapshot) {
    const limit = snapshot.limits.find(({ limitId }) => limitId === "codex");
    const weekly = [limit?.primary, limit?.secondary].find(({ windowMinutes } = {}) => windowMinutes === WEEKLY_WINDOW_MINUTES);
    if (weekly?.usedPercent === undefined)
        return undefined;
    return 100 - Math.max(0, Math.min(100, weekly.usedPercent));
}
export function parseCodexRateLimitResetConsumePayload(payload) {
    const root = isRecord(payload) ? payload : {};
    const code = stringValue(root["code"]);
    const outcome = code === "reset" || code === "already_redeemed" || code === "nothing_to_reset" || code === "no_credit" ? code : "unknown";
    return { outcome, windowsReset: integerValue(root["windows_reset"]), raw: payload };
}
