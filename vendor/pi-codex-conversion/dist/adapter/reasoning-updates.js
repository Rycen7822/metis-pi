import { randomUUID } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
export const CODEX_REASONING_UPDATE_TYPE = "codex-reasoning-update";
const pendingUpdates = new WeakMap();
export function flushCodexReasoningUpdates(pi, ctx) {
    const pending = pendingUpdates.get(pi);
    pendingUpdates.delete(pi);
    if (pending?.sessionId !== ctx.sessionManager.getSessionId())
        return;
    if (pending.compactionId !== ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id)
        return;
    for (const update of pending.updates)
        pi.appendEntry(CODEX_REASONING_UPDATE_TYPE, update);
}
export function supportsCodexReasoningUpdates(model) {
    return model?.api === "openai-codex-responses" && model.id.split("/").at(-1)?.toLowerCase() === "gpt-6-astra";
}
export function codexReasoningLane(model) {
    return JSON.stringify([model.provider, model.api, model.id]);
}
export function readCodexReasoningUpdate(value) {
    if (!value || typeof value !== "object"
        || !("protocol" in value) || value.protocol !== 1
        || !("id" in value) || typeof value.id !== "string" || !value.id
        || !("lane" in value) || typeof value.lane !== "string" || !value.lane
        || !("initialEffort" in value) || !validEffort(value.initialEffort)
        || !("effort" in value) || !validEffort(value.effort)) {
        throw new Error("Malformed persisted Codex reasoning update");
    }
    return value;
}
function validEffort(value) {
    return typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value);
}
function effortForLevel(model, level) {
    const clamped = clampThinkingLevel(model, level);
    const effort = model.thinkingLevelMap?.[clamped] ?? (clamped === "minimal" ? "low" : clamped);
    if (!validEffort(effort))
        throw new Error(`Unsupported Astra reasoning effort: ${effort}`);
    return effort;
}
export function codexReasoningUpdates(messages, model) {
    if (!supportsCodexReasoningUpdates(model))
        return [];
    const lane = codexReasoningLane(model);
    return messages.flatMap((message) => {
        if (message.role !== "custom" || message.customType !== CODEX_REASONING_UPDATE_TYPE)
            return [];
        const update = readCodexReasoningUpdate(message.details);
        return update.lane === lane ? [update] : [];
    });
}
/** Record the selector change, not a replacement of earlier model-visible history. */
export function recordCodexReasoningUpdate(pi, ctx, messages, previousLevel) {
    const model = ctx.model;
    if (!model || !supportsCodexReasoningUpdates(model))
        return;
    const lane = codexReasoningLane(model);
    const sessionId = ctx.sessionManager.getSessionId();
    const compactionId = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "compaction")?.id;
    const pending = pendingUpdates.get(pi);
    const queued = pending?.sessionId === sessionId && pending.compactionId === compactionId ? pending.updates : [];
    const updates = [...codexReasoningUpdates(messages, model), ...queued.filter((update) => update.lane === lane)];
    const effort = effortForLevel(model, pi.getThinkingLevel());
    // Streaming changes become bookkeeping only after the current tool batch finishes.
    const previous = previousLevel ? effortForLevel(model, previousLevel) : updates.at(-1)?.effort;
    if (previous === undefined || previous === effort)
        return;
    const update = { protocol: 1, id: randomUUID(), lane, initialEffort: updates[0]?.initialEffort ?? previous, effort };
    if (ctx.isIdle()) {
        flushCodexReasoningUpdates(pi, ctx);
        pi.appendEntry(CODEX_REASONING_UPDATE_TYPE, update);
    }
    else
        pendingUpdates.set(pi, { sessionId, compactionId, updates: [...queued, update] });
}
export function hasPendingCodexReasoningUpdate(messages) {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role === "assistant")
            return false;
        if (message.role === "custom" && message.customType === CODEX_REASONING_UPDATE_TYPE)
            return true;
    }
    return false;
}
/** Run after replay too: native checkpoints can restore an update at the tail. */
export function normalizeCodexConfigurationUpdates(body) {
    const isUpdate = (item) => Boolean(item && typeof item === "object" && "type" in item && item.type === "configuration_update");
    if (!body.input.some(isUpdate))
        return body;
    // A model switch is a new lane; Astra-only configuration is not portable.
    if (body.model && body.model.split("/").at(-1)?.toLowerCase() !== "gpt-6-astra")
        return { ...body, input: body.input.filter((item) => !isUpdate(item)) };
    if (body["truncation"] === "auto" || (Array.isArray(body["context_management"]) && body["context_management"].length > 0)) {
        throw new Error("Astra reasoning updates cannot use automatic truncation or server automatic compaction; use an explicit compaction_trigger");
    }
    // Multiple selector presses before a response are one effective update.
    // Persisted records stay intact; never append adjacent native updates.
    const input = [];
    for (const item of body.input) {
        if (isUpdate(item) && isUpdate(input.at(-1)))
            input.pop();
        input.push(item);
    }
    return { ...body, input };
}
