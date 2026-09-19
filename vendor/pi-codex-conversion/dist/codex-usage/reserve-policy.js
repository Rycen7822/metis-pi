export const CODEX_RESERVE_MODEL = "gpt-reserve";
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
// Identity and the backend banner authorize switching; a visible quota bucket does not.
export function parseCodexReserveStatus(payload, identity, modelId) {
    const root = record(payload);
    if (root["account_id"] !== identity.accountId || root["user_id"] !== identity.userId)
        return undefined;
    const banner = record(root["rate_limit_upsell"]);
    const ordinaryAllowed = record(root["rate_limit"])["allowed"];
    const credits = record(root["credits"]);
    return {
        accountKey: JSON.stringify([identity.accountId, identity.userId]),
        entryAllowed: banner["banner_type"] === "luna_reserve"
            && (banner["blocked_model_slug"] == null || banner["blocked_model_slug"] === modelId),
        ordinaryUsageRecovered: typeof ordinaryAllowed === "boolean"
            && (ordinaryAllowed || credits["has_credits"] === true || credits["unlimited"] === true)
            && root["rate_limit_upsell"] == null
            && record(root["spend_control"])["reached"] !== true
            && root["rate_limit_reached_type"] == null,
    };
}
