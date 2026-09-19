import { isCodexTransportModel } from "../prompt/codex-model.js";
export const DEFAULT_SUPPORTED_PROVIDERS = ["openai", "openai-codex"];
export const DEFAULT_SUPPORTED_APIS = ["openai-responses", "openai-codex-responses"];
function normalizeConfiguredSet(values, defaults) {
    const source = values && values.length > 0 ? values : defaults;
    return new Set(source.map((value) => value.trim()).filter((value) => value.length > 0));
}
function normalizeConfiguredProviderSet(values) {
    return new Set([...normalizeConfiguredSet(values, DEFAULT_SUPPORTED_PROVIDERS)].map((value) => value.toLowerCase()));
}
export function normalizeBaseUrl(baseUrl) {
    const normalized = baseUrl?.trim().replace(/\/+$/, "");
    return normalized ? normalized : undefined;
}
async function resolveRequestAuth(ctx, model) {
    const modelRegistry = ctx.modelRegistry;
    if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
        return {};
    }
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    return auth && auth.ok ? { apiKey: auth.apiKey, headers: auth.headers, baseUrl: auth.baseUrl, env: auth.env } : {};
}
export function isSupportedApi(api) {
    return DEFAULT_SUPPORTED_APIS.includes(api);
}
export function isResponsesCompatiblePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return false;
    }
    const candidate = payload;
    return typeof candidate["model"] === "string" && Array.isArray(candidate["input"]);
}
export function getRuntimeModelDescriptor(model) {
    if (!model) {
        return {};
    }
    return {
        provider: model.provider,
        api: model.api,
        model: model.id,
        baseUrl: normalizeBaseUrl(model.baseUrl),
    };
}
export async function resolveNativeCompactionEnvironment(ctx, options = {}, payload) {
    if (options.enabled === false) {
        return {
            ok: false,
            reason: "disabled",
        };
    }
    const currentModel = ctx.model;
    const descriptor = getRuntimeModelDescriptor(currentModel);
    if (!currentModel || !descriptor.provider || !descriptor.api || !descriptor.model) {
        return {
            ok: false,
            reason: "missing-model",
            ...descriptor,
        };
    }
    const supportedApis = normalizeConfiguredSet(options.supportedApis, DEFAULT_SUPPORTED_APIS);
    if (!supportedApis.has(descriptor.api)) {
        return {
            ok: false,
            reason: "unsupported-api",
            ...descriptor,
        };
    }
    if (!isSupportedApi(descriptor.api)) {
        return {
            ok: false,
            reason: "unsupported-api",
            ...descriptor,
        };
    }
    const supportedProviders = normalizeConfiguredProviderSet(options.supportedProviders);
    const providerSupported = supportedProviders.has(descriptor.provider.trim().toLowerCase());
    if (!providerSupported && !isCodexTransportModel(currentModel)) {
        return {
            ok: false,
            reason: "unsupported-provider",
            ...descriptor,
        };
    }
    const { apiKey, headers, baseUrl: authBaseUrl, env } = await resolveRequestAuth(ctx, currentModel);
    const effectiveBaseUrl = normalizeBaseUrl(authBaseUrl) ?? descriptor.baseUrl;
    if (!effectiveBaseUrl) {
        return {
            ok: false,
            reason: "missing-base-url",
            ...descriptor,
        };
    }
    const codexTransport = isCodexTransportModel(currentModel);
    let requestPayload;
    if (payload !== undefined) {
        if (!isResponsesCompatiblePayload(payload)) {
            return {
                ok: false,
                reason: "unsupported-payload",
                ...descriptor,
            };
        }
        if (payload.model !== descriptor.model) {
            return {
                ok: false,
                reason: "payload-model-mismatch",
                ...descriptor,
            };
        }
        requestPayload = payload;
    }
    const resolvedApiKey = apiKey ?? bearerToken(headers);
    if (!resolvedApiKey) {
        return {
            ok: false,
            reason: "missing-api-key",
            ...descriptor,
        };
    }
    return {
        ok: true,
        runtime: {
            provider: descriptor.provider,
            api: descriptor.api,
            apiFamily: descriptor.api,
            codexTransport,
            model: descriptor.model,
            baseUrl: effectiveBaseUrl,
            apiKey: resolvedApiKey,
            headers,
            env,
            payload: requestPayload,
            currentModel: authBaseUrl ? { ...currentModel, baseUrl: effectiveBaseUrl } : currentModel,
        },
    };
}
function bearerToken(headers) {
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() !== "authorization" || typeof value !== "string")
            continue;
        const match = value.trim().match(/^Bearer\s+(.+)$/i);
        if (match?.[1]?.trim())
            return match[1].trim();
    }
    return undefined;
}
