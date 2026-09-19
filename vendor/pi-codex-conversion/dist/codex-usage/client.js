import { createHash } from "node:crypto";
import { isCanonicalCodexBaseUrl, isCanonicalCodexSubscriptionModel } from "../adapter/prompt/codex-model.js";
import { DEFAULT_CODEX_BASE_URL, JWT_CLAIM_PATH } from "../providers/openai-codex/constants.js";
import { parseCodexReserveStatus } from "./reserve-policy.js";
import { codexWeeklyUsageLeft, parseCodexRateLimitResetConsumePayload, parseCodexRateLimitResetCreditsPayload, parseCodexUsagePayload, } from "./payload.js";
const RESET_CREDITS_CACHE_MS = 5_000;
const WEEKLY_USAGE_CACHE_MS = 5 * 60_000;
const WEEKLY_USAGE_TIMEOUT_MS = 10_000;
let resetCreditsCache;
const weeklyUsageCache = new Map();
const weeklyUsageKeyByModel = new WeakMap();
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
export function buildCodexUsageUrl() {
    return `${DEFAULT_CODEX_BASE_URL}/wham/usage`;
}
export function buildCodexRateLimitResetCreditsUrl() {
    return `${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits`;
}
export function buildCodexRateLimitResetConsumeUrl() {
    return `${DEFAULT_CODEX_BASE_URL}/wham/rate-limit-reset-credits/consume`;
}
function extractIdentity(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            return {};
        const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
        const authClaims = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
        if (!isRecord(authClaims))
            return {};
        return {
            accountId: stringValue(authClaims["chatgpt_account_id"]),
            userId: stringValue(authClaims["chatgpt_user_id"]) ?? stringValue(authClaims["user_id"]),
            fedramp: authClaims["chatgpt_account_is_fedramp"] === true,
        };
    }
    catch {
        return {};
    }
}
async function buildCodexUsageHeaders(ctx, model) {
    if (!isCanonicalCodexSubscriptionModel(model)) {
        throw new Error("Codex usage requires the canonical ChatGPT subscription endpoint.");
    }
    const resolved = await ctx.modelRegistry.getProviderAuth(model.provider);
    const token = resolved?.auth.apiKey;
    if (!token || !isCanonicalCodexBaseUrl(resolved?.auth.baseUrl ?? model.baseUrl)) {
        throw new Error("Canonical OpenAI Codex subscription auth is required.");
    }
    const { accountId } = extractIdentity(token);
    if (!accountId)
        throw new Error("Canonical OpenAI Codex subscription auth is required.");
    const headers = new Headers({
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
    });
    headers.set("accept", "application/json");
    headers.set("OAI-Language", "en");
    headers.set("originator", "pi");
    return headers;
}
function resetCreditsCacheKey(headers) {
    return headers.get("chatgpt-account-id")?.trim() || undefined;
}
function usageCacheKey(headers) {
    const accountId = resetCreditsCacheKey(headers);
    if (accountId)
        return `account:${accountId}`;
    const authorization = headers.get("authorization")?.trim();
    return authorization
        ? `auth:${createHash("sha256").update(authorization).digest("hex")}`
        : undefined;
}
async function fetchCodexRateLimitResetCreditsWithHeaders(headers, signal) {
    const cacheKey = resetCreditsCacheKey(headers);
    if (cacheKey && resetCreditsCache && resetCreditsCache.key === cacheKey && resetCreditsCache.expiresAt > Date.now())
        return resetCreditsCache.promise;
    const promise = (async () => {
        const response = await fetch(buildCodexRateLimitResetCreditsUrl(), { method: "GET", headers, ...(signal ? { signal } : {}) });
        if (!response.ok)
            return undefined;
        return parseCodexRateLimitResetCreditsPayload(JSON.parse(await response.text()));
    })();
    if (cacheKey)
        resetCreditsCache = { key: cacheKey, expiresAt: Date.now() + RESET_CREDITS_CACHE_MS, promise };
    return promise;
}
async function fetchCodexUsageWithHeaders(headers, signal, includeDetailedResetCredits = true) {
    const response = await fetch(buildCodexUsageUrl(), { method: "GET", headers, ...(signal ? { signal } : {}) });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`Usage request failed (${response.status}): ${text || response.statusText}`);
    const snapshot = parseCodexUsagePayload(JSON.parse(text));
    if (includeDetailedResetCredits && (!snapshot.resetCredits || snapshot.resetCredits.availableCount > 0)) {
        try {
            const detailedResetCredits = await fetchCodexRateLimitResetCreditsWithHeaders(headers, signal);
            if (detailedResetCredits)
                snapshot.resetCredits = detailedResetCredits;
        }
        catch {
            // Detailed reset-credit metadata is additive; usage still renders if this endpoint fails.
        }
    }
    return snapshot;
}
export async function fetchCodexUsage(ctx) {
    const model = ctx.model;
    if (!model)
        throw new Error("No active model selected.");
    if (!isCanonicalCodexSubscriptionModel(model)) {
        throw new Error("Codex usage is only available for canonical OpenAI Codex subscription models.");
    }
    const headers = await buildCodexUsageHeaders(ctx, model);
    return fetchCodexUsageWithHeaders(headers, ctx.signal);
}
// Only the fallback controller opts in. Passive usage reads must not expose the experiment.
export async function fetchCodexReserveStatus(ctx) {
    const model = ctx.model;
    if (!model || !isCanonicalCodexSubscriptionModel(model))
        return undefined;
    const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(WEEKLY_USAGE_TIMEOUT_MS)])
        : AbortSignal.timeout(WEEKLY_USAGE_TIMEOUT_MS);
    const headers = await withAbort(buildCodexUsageHeaders(ctx, model), signal);
    const { accountId, userId, fedramp } = extractIdentity((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!accountId || !userId || fedramp)
        return undefined;
    headers.set("x-openai-codex-luna-reserve", "1");
    const snapshot = await fetchCodexUsageWithHeaders(headers, signal, false);
    const currentHeaders = await withAbort(buildCodexUsageHeaders(ctx, model), signal);
    const current = extractIdentity((currentHeaders.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (current.accountId !== accountId || current.userId !== userId || current.fedramp)
        return undefined;
    return parseCodexReserveStatus(snapshot.raw, { accountId, userId }, model.id);
}
export async function fetchCodexWeeklyUsageLeft(ctx) {
    const model = ctx.model;
    if (!model || !isCanonicalCodexSubscriptionModel(model))
        return undefined;
    const timeoutSignal = AbortSignal.timeout(WEEKLY_USAGE_TIMEOUT_MS);
    const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal])
        : timeoutSignal;
    try {
        const headers = await withAbort(buildCodexUsageHeaders(ctx, model), signal);
        const key = usageCacheKey(headers);
        if (!key)
            return undefined;
        weeklyUsageKeyByModel.set(model, key);
        const cached = weeklyUsageCache.get(key);
        if (cached?.expiresAt && cached.expiresAt > Date.now())
            return cached.value;
        if (cached?.promise)
            return cached.promise;
        const entry = cached ?? { expiresAt: 0 };
        const previous = entry.value;
        const promise = (async () => {
            try {
                entry.value = codexWeeklyUsageLeft(await fetchCodexUsageWithHeaders(headers, signal, false));
                entry.expiresAt = Date.now() + WEEKLY_USAGE_CACHE_MS;
            }
            catch {
                entry.value = previous;
            }
            finally {
                entry.promise = undefined;
            }
            return entry.value;
        })();
        entry.promise = promise;
        weeklyUsageCache.set(key, entry);
        return promise;
    }
    catch {
        const previousKey = weeklyUsageKeyByModel.get(model);
        return previousKey ? weeklyUsageCache.get(previousKey)?.value : undefined;
    }
}
function withAbort(promise, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}
export function createCodexRateLimitResetRedeemRequestId() {
    return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `pi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
export async function consumeCodexRateLimitResetCredit(ctx, redeemRequestId = createCodexRateLimitResetRedeemRequestId()) {
    const model = ctx.model;
    if (!model)
        throw new Error("No active model selected.");
    if (!isCanonicalCodexSubscriptionModel(model)) {
        throw new Error("Codex reset credits are only available for canonical OpenAI Codex subscription models.");
    }
    const headers = await buildCodexUsageHeaders(ctx, model);
    headers.set("content-type", "application/json");
    resetCreditsCache = undefined;
    const response = await fetch(buildCodexRateLimitResetConsumeUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify({ redeem_request_id: redeemRequestId }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`Reset request failed (${response.status}): ${text || response.statusText}`);
    resetCreditsCache = undefined;
    const result = parseCodexRateLimitResetConsumePayload(JSON.parse(text));
    if (result.outcome === "reset" || result.outcome === "already_redeemed") {
        const key = usageCacheKey(headers);
        if (key)
            weeklyUsageCache.delete(key);
    }
    return result;
}
