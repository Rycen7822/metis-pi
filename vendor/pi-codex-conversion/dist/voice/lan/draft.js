const MAX_LAN_VOICE_DRAFT_BYTES = 64 * 1024;
export class LanVoiceDraftError extends Error {
}
export class LanVoiceDraftConflictError extends LanVoiceDraftError {
}
export class LanVoiceDraft {
    publish;
    sendMessage;
    text = "";
    revision = 0;
    constructor(options) {
        this.publish = options.publish;
        this.sendMessage = options.sendMessage;
    }
    snapshot(sourceClientId, reason) {
        return {
            type: "draft",
            text: this.text,
            revision: this.revision,
            ...(sourceClientId ? { sourceClientId } : {}),
            ...(reason ? { reason } : {}),
        };
    }
    update(clientId, value, expectedRevision) {
        this.assertRevision(expectedRevision);
        this.text = validatedDraft(value);
        this.revision += 1;
        this.publish(this.snapshot(clientId, "update"));
        return this.revision;
    }
    insertTranscript(clientId, transcript, selection) {
        const clean = transcript.trim();
        if (!clean)
            return;
        const start = boundedIndex(selection?.start, this.text.length, this.text.length);
        const end = boundedIndex(selection?.end, this.text.length, start);
        const before = this.text.slice(0, Math.min(start, end));
        const after = this.text.slice(Math.max(start, end));
        const leftSpace = before && !/\s$/.test(before) ? " " : "";
        const rightSpace = after && !/^\s/.test(after) ? " " : "";
        this.text = validatedDraft(`${before}${leftSpace}${clean}${rightSpace}${after}`);
        this.revision += 1;
        this.publish(this.snapshot(clientId, "transcript"));
    }
    send(clientId, value, expectedRevision) {
        this.assertRevision(expectedRevision);
        const text = validatedDraft(value);
        if (!text.trim())
            throw new LanVoiceDraftError("A message is required");
        this.text = text;
        this.sendMessage(text);
        if (this.text === text)
            this.text = "";
        this.revision += 1;
        this.publish({ type: "sent" });
        this.publish(this.snapshot(clientId, "sent"));
    }
    assertRevision(value) {
        if (!Number.isInteger(value) || value !== this.revision)
            throw new LanVoiceDraftConflictError("Draft changed on another device; review it and try again");
    }
}
function validatedDraft(value) {
    if (typeof value !== "string")
        throw new LanVoiceDraftError("Draft text is required");
    if (Buffer.byteLength(value) > MAX_LAN_VOICE_DRAFT_BYTES)
        throw new LanVoiceDraftError("Draft is too large");
    return value;
}
function boundedIndex(value, length, fallback) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= length ? value : fallback;
}
