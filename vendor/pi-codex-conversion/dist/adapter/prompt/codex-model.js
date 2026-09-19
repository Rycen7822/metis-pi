export function isOpenAICodexModel(model) {
    if (!model)
        return false;
    return (model.provider ?? "").toLowerCase() === "openai-codex";
}
export function isCanonicalCodexBaseUrl(value) {
    if (!value?.trim())
        return false;
    try {
        const url = new URL(value);
        const path = url.pathname.replace(/\/+$/, "");
        return url.protocol === "https:"
            && url.hostname === "chatgpt.com"
            && url.port === ""
            && url.username === ""
            && url.password === ""
            && url.search === ""
            && url.hash === ""
            && (path === "/backend-api" || path === "/backend-api/codex");
    }
    catch {
        return false;
    }
}
export function isCanonicalCodexSubscriptionModel(model) {
    return Boolean(model
        && model.api === "openai-codex-responses"
        && isCanonicalCodexBaseUrl(model.baseUrl));
}
export function isCodexTransportModel(model) {
    return Boolean(model && (isOpenAICodexModel(model)
        || (model.api ?? "").trim().toLowerCase() === "openai-codex-responses"));
}
export function isResponsesModel(model) {
    if (!model)
        return false;
    return (model.api ?? "").toLowerCase().includes("responses");
}
// Keep model detection intentionally conservative. The adapter replaces the
// system prompt and tool surface, so false positives are worse than misses.
export function isCodexLikeModel(model) {
    if (!model)
        return false;
    const provider = (model.provider ?? "").toLowerCase();
    const api = (model.api ?? "").toLowerCase();
    const id = (model.id ?? "").toLowerCase();
    const isCopilotGpt = (provider.includes("copilot") || api.includes("copilot")) && id.includes("gpt");
    return provider.includes("codex") || api.includes("codex") || id.includes("codex") || (provider.includes("openai") && id.includes("gpt")) || isCopilotGpt;
}
export function isCodexTransportContext(ctx) {
    return isCodexTransportModel(ctx.model);
}
export function isResponsesContext(ctx) {
    return isResponsesModel(ctx.model);
}
export function isOpenAIResponsesContext(ctx) {
    return (ctx.model?.api ?? "").trim().toLowerCase() === "openai-responses";
}
