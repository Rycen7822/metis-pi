import { randomUUID } from "node:crypto";
export const CODEX_DEVELOPER_MESSAGE_TYPE = "codex-developer-message";
const CUSTOM_DEVELOPER_DETAILS_KEY = "@howaboua/pi-codex-conversion/developer-message";
const DEVELOPER_MESSAGE_CHANNEL = "@howaboua/pi-codex-conversion.developer-message/v1";
const CUSTOM_DEVELOPER_MESSAGE_CHANNEL = "@howaboua/pi-codex-conversion.developer-custom-message/v1";
const PREPARED_IDLE_KICKOFF_CHANNEL = "@howaboua/pi-codex-conversion.prepared-idle-kickoff/v1";
export function sendCodexDeveloperMessage(pi, content, options) {
    const outcome = dispatchCodexDeveloperMessage(pi, content, options);
    if (!outcome.ok)
        throw new Error(outcome.error);
}
export function trySendCodexDeveloperMessage(pi, content, options) {
    const outcome = dispatchCodexDeveloperMessage(pi, content, options);
    if (outcome.ok)
        return true;
    if (outcome.reason === "unavailable")
        return false;
    throw new Error(outcome.error);
}
/** Preserve caller rendering and detail fields; false means nothing was sent. */
export function trySendCodexDeveloperCustomMessage(pi, message, options) {
    validateCustomMessage(message);
    const outcome = dispatchCodexDeveloperMessage(pi, message.content, options, message);
    if (outcome.ok)
        return true;
    if (outcome.reason === "unavailable")
        return false;
    throw new Error(outcome.error);
}
export function tryStartCodexPreparedIdleKickoff(pi, ctx) {
    const outcome = tryStartCodexPreparedIdlePrompt(pi);
    if (outcome === "pending") {
        ctx.ui.notify("An automatic turn is pending. If no turn starts, send a user message or reload the session.", "warning");
    }
    return outcome !== false;
}
/** Claim idle preparation; callback prompts are distinct, never coalesced away. */
export function tryStartCodexPreparedIdlePrompt(pi, start) {
    const request = { protocol: 1, action: "claim", ...(start ? { start } : {}) };
    pi.events.emit(PREPARED_IDLE_KICKOFF_CHANNEL, request);
    if (request.outcome && typeof request.outcome === "object")
        throw new Error(request.outcome.error);
    return request.outcome ?? false;
}
export function updateCodexPreparedIdleKickoff(pi, action) {
    const request = {
        protocol: 1,
        action,
    };
    pi.events.emit(PREPARED_IDLE_KICKOFF_CHANNEL, request);
    if (request.outcome && typeof request.outcome === "object")
        throw new Error(request.outcome.error);
}
function dispatchCodexDeveloperMessage(pi, content, options, message) {
    if (typeof content !== "string" || content.trim() === "")
        throw new Error("Codex developer message content cannot be empty");
    validateOptions(options);
    const request = {
        protocol: 1,
        content,
        ...(options ? { options } : {}),
        ...(message ? { message } : {}),
    };
    pi.events.emit(message ? CUSTOM_DEVELOPER_MESSAGE_CHANNEL : DEVELOPER_MESSAGE_CHANNEL, request);
    return (request.outcome ?? {
        ok: false,
        reason: "unavailable",
        error: "Pi Codex developer messages are unavailable",
    });
}
export function registerCodexDeveloperMessageBroker(pi, isActive) {
    let preparedIdleKickoff;
    const startKickoff = (start) => {
        // Pi exposes no completion for async preflight. Lifecycle owners clear the
        // claim; guessing here could launch a concurrent turn.
        preparedIdleKickoff = "preparing";
        try {
            if (start)
                start();
            else
                pi.sendUserMessage("Continue.", { deliverAs: "steer" });
            return "started";
        }
        catch (error) {
            preparedIdleKickoff = undefined;
            return { error: error instanceof Error ? error.message : String(error) };
        }
    };
    const deliver = (value) => {
        if (!isDeveloperMessageRequest(value) || value.outcome)
            return;
        if (!isActive()) {
            value.outcome = {
                ok: false,
                reason: "unavailable",
                error: "Pi Codex developer messages require an active Responses adapter",
            };
            return;
        }
        try {
            const metadata = { protocol: 1, id: randomUUID() };
            pi.sendMessage(value.message ? {
                ...value.message,
                details: { ...value.message.details, [CUSTOM_DEVELOPER_DETAILS_KEY]: metadata },
            } : {
                customType: CODEX_DEVELOPER_MESSAGE_TYPE,
                content: value.content,
                display: true,
                details: metadata,
            }, value.options);
            value.outcome = { ok: true };
        }
        catch (error) {
            value.outcome = {
                ok: false,
                reason: "delivery",
                error: error instanceof Error ? error.message : String(error),
            };
        }
    };
    const kickoff = (value) => {
        if (!isPreparedIdleKickoffRequest(value))
            return;
        if (value.action === "session_reset") {
            preparedIdleKickoff = undefined;
            return;
        }
        if (value.action === "agent_start") {
            if (preparedIdleKickoff === "preparing")
                preparedIdleKickoff = "running";
            return;
        }
        if (value.action === "agent_settled") {
            if (preparedIdleKickoff === "queued")
                value.outcome = startKickoff();
            else if (preparedIdleKickoff === "running")
                preparedIdleKickoff = undefined;
            return;
        }
        if (value.outcome)
            return;
        if (preparedIdleKickoff) {
            if (value.start) {
                value.outcome = { error: "Target has a pending turn; retry after it starts or settles" };
                return;
            }
            // Pi becomes idle before awaiting settlement handlers. A claim then
            // belongs to the next turn, not the response that just finished.
            if (preparedIdleKickoff === "running")
                preparedIdleKickoff = "queued";
            value.outcome = "pending";
            return;
        }
        value.outcome = startKickoff(value.start);
    };
    const clearPreparedIdleKickoff = () => {
        preparedIdleKickoff = undefined;
    };
    const unregister = [
        pi.events.on(DEVELOPER_MESSAGE_CHANNEL, deliver),
        pi.events.on(CUSTOM_DEVELOPER_MESSAGE_CHANNEL, deliver),
        pi.events.on(PREPARED_IDLE_KICKOFF_CHANNEL, kickoff),
    ];
    return () => {
        clearPreparedIdleKickoff();
        for (const remove of unregister)
            remove();
    };
}
export function customDeveloperMessageMetadata(details) {
    return details && typeof details === "object" && CUSTOM_DEVELOPER_DETAILS_KEY in details
        ? details[CUSTOM_DEVELOPER_DETAILS_KEY] : undefined;
}
function validateCustomMessage(message) {
    if (!message || typeof message !== "object" ||
        typeof message.customType !== "string" || !message.customType.trim() ||
        typeof message.display !== "boolean")
        throw new Error("Codex developer custom messages require a caller-owned customType and boolean display");
    const details = message.details;
    if (details !== undefined && (!details || typeof details !== "object" ||
        (Object.getPrototypeOf(details) !== Object.prototype && Object.getPrototypeOf(details) !== null) ||
        CUSTOM_DEVELOPER_DETAILS_KEY in details))
        throw new Error("Codex developer custom message details must be a plain object without the reserved developer-message key");
}
export function isCodexDeveloperMessageDetails(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "protocol" in value &&
        value.protocol === 1 &&
        "id" in value &&
        typeof value.id === "string" &&
        value.id.trim() !== "");
}
function isDeveloperMessageRequest(value) {
    if (!value ||
        typeof value !== "object" ||
        !("protocol" in value) ||
        value.protocol !== 1 ||
        !("content" in value) ||
        typeof value.content !== "string" ||
        value.content.trim() === "")
        return false;
    if ("outcome" in value &&
        value.outcome !== undefined &&
        !isDeveloperMessageOutcome(value.outcome))
        return false;
    try {
        if ("message" in value && value.message !== undefined) {
            validateCustomMessage(value.message);
            if (value.message.content !== value.content)
                return false;
        }
        validateOptions("options" in value
            ? value.options
            : undefined);
        return true;
    }
    catch {
        return false;
    }
}
function isDeveloperMessageOutcome(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "ok" in value &&
        (value.ok === true ||
            (value.ok === false &&
                "reason" in value &&
                (value.reason === "unavailable" || value.reason === "delivery") &&
                "error" in value &&
                typeof value.error === "string")));
}
function isPreparedIdleKickoffRequest(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "protocol" in value &&
        value.protocol === 1 &&
        "action" in value &&
        (!("start" in value) || typeof value.start === "function") &&
        (value.action === "claim" ||
            value.action === "agent_start" ||
            value.action === "agent_settled" ||
            value.action === "session_reset") &&
        (!("outcome" in value) || value.outcome === undefined));
}
function validateOptions(options) {
    if (options === undefined)
        return;
    if (!options || typeof options !== "object")
        throw new Error("Codex developer message options must be an object");
    if (options.deliverAs !== undefined &&
        options.deliverAs !== "steer" &&
        options.deliverAs !== "followUp" &&
        options.deliverAs !== "nextTurn")
        throw new Error("Invalid Codex developer message delivery mode");
    if (options.triggerTurn !== undefined &&
        typeof options.triggerTurn !== "boolean")
        throw new Error("Codex developer message triggerTurn must be boolean");
}
