import { renderPiSteer } from "../prompts.js";
/** Routes one Pi turn back into the active realtime conversation. */
export class RealtimeDelegationHandoff {
    callbacks;
    target;
    buffer = "";
    streamedProgress = false;
    queuedSteers = [];
    queuedFollowUps = [];
    constructor(callbacks) {
        this.callbacks = callbacks;
    }
    activate(id) {
        if (!this.callbacks.isActive() ||
            (this.target?.type === "delegation" && this.target.id === id))
            return;
        this.finishResult();
        if (!this.callbacks.isActive())
            return;
        this.settleDelegation();
        this.target = { type: "delegation", id };
    }
    piInput(input, streamingBehavior) {
        const frame = renderPiSteer(input);
        if (!this.callbacks.isActive() || !frame || typeof input !== "string")
            return false;
        const normalizedInput = input.trim();
        if (streamingBehavior === "followUp") {
            this.queuedFollowUps.push({ input: normalizedInput, frame });
            return true;
        }
        if (streamingBehavior === "steer")
            this.queuedSteers.push(normalizedInput);
        this.routePiInput(frame, streamingBehavior === undefined);
        return true;
    }
    piUserMessage(message) {
        if (!this.callbacks.isActive())
            return false;
        const input = userMessageText(message);
        if (!input)
            return false;
        const steerIndex = this.queuedSteers.indexOf(input);
        if (steerIndex >= 0) {
            this.queuedSteers.splice(steerIndex, 1);
            return true;
        }
        const followUpIndex = this.queuedFollowUps.findIndex((pending) => pending.input === input);
        if (followUpIndex < 0)
            return false;
        const [pending] = this.queuedFollowUps.splice(followUpIndex, 1);
        if (!pending)
            return false;
        this.routePiInput(pending.frame, true);
        return true;
    }
    routePiInput(frame, startsTurn) {
        if (startsTurn) {
            this.finishResult();
            this.settleDelegation();
            this.target = { type: "session" };
        }
        else if (!this.target) {
            this.target = { type: "session" };
        }
        if (!this.target)
            return;
        this.callbacks.onContext(this.target, "commentary", frame);
    }
    stream(delta) {
        if (!this.callbacks.isActive() || !this.target || !delta)
            return;
        this.buffer += delta;
        for (;;) {
            const boundary = this.streamedProgress
                ? paragraphBoundary(this.buffer)
                : secondSentenceBoundary(this.buffer);
            if (boundary === undefined)
                break;
            // Keep final speech for the request that owns the result. Formatting
            // alone after the boundary is not a speakable tail.
            if (!/[\p{L}\p{N}]/u.test(this.buffer.slice(boundary)))
                break;
            const chunk = this.buffer.slice(0, boundary);
            this.buffer = this.buffer.slice(boundary);
            if (chunk.trim()) {
                this.callbacks.onContext({ type: "session" }, "speakable", chunk);
                this.streamedProgress = true;
            }
        }
    }
    progress(content) {
        this.finishProgress(content);
    }
    result(content) {
        this.finishResult(content);
    }
    settle() {
        this.finishResult();
        this.settleDelegation();
        this.target = undefined;
        this.clearQueuedInputs();
    }
    clear() {
        this.target = undefined;
        this.buffer = "";
        this.streamedProgress = false;
        this.clearQueuedInputs();
    }
    finishProgress(fallback = "") {
        const text = (this.streamedProgress ? this.buffer : fallback).trim();
        this.buffer = "";
        this.streamedProgress = false;
        if (!this.callbacks.isActive() || !this.target || !text)
            return;
        this.callbacks.onContext({ type: "session" }, "speakable", text);
    }
    finishResult(fallback = "") {
        const text = (this.streamedProgress ? this.buffer : fallback || this.buffer).trim();
        this.buffer = "";
        this.streamedProgress = false;
        if (!this.callbacks.isActive() || !this.target || !text)
            return;
        this.callbacks.onContext(this.target, "speakable", text);
    }
    clearQueuedInputs() {
        this.queuedSteers.length = 0;
        this.queuedFollowUps.length = 0;
    }
    settleDelegation() {
        if (this.target?.type === "delegation")
            this.callbacks.onSettled(this.target.id);
    }
}
function secondSentenceBoundary(text) {
    const ends = [...text.matchAll(/[.!?](?:["')\]]+)?(?=\s|$)/g)];
    return ends[1]?.index === undefined
        ? undefined
        : ends[1].index + ends[1][0].length;
}
function paragraphBoundary(text) {
    const match = /\n\s*\n/.exec(text);
    return match?.index === undefined ? undefined : match.index + match[0].length;
}
function userMessageText(message) {
    if (!message || typeof message !== "object")
        return undefined;
    const candidate = message;
    if (candidate.role !== "user")
        return undefined;
    if (typeof candidate.content === "string")
        return candidate.content.trim() || undefined;
    if (!Array.isArray(candidate.content))
        return undefined;
    const text = candidate.content
        .flatMap((part) => part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string"
        ? [part.text]
        : [])
        .join("\n")
        .trim();
    return text || undefined;
}
