import { isObject } from "./activation/config.js";
export function applyCodexRequestOptions(payload, config, options = { serviceTier: true, verbosity: true }) {
    if (!isObject(payload))
        return payload;
    const text = isObject(payload["text"]) ? payload["text"] : {};
    return {
        ...payload,
        ...(options.serviceTier && config.openai.fast ? { service_tier: "priority" } : {}),
        ...(options.verbosity ? { text: { ...text, verbosity: config.openai.verbosity } } : {}),
    };
}
