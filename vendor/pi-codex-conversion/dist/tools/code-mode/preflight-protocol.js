export const PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
export const PREFLIGHT_REQUEST_CHANNEL = `${PREFLIGHT_PROTOCOL}/request`;
export const PREFLIGHT_AVAILABLE_CHANNEL = `${PREFLIGHT_PROTOCOL}/available`;
export function isProtocolRequest(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "protocol" in value &&
        value.protocol === PREFLIGHT_PROTOCOL);
}
export function isPreflightBroker(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "protocol" in value &&
        value.protocol === PREFLIGHT_PROTOCOL &&
        "isActive" in value &&
        typeof value.isActive === "function" &&
        "register" in value &&
        typeof value.register === "function");
}
