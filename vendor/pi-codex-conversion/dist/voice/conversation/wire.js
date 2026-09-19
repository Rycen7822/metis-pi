import { createHash } from "node:crypto";
import { MAX_REALTIME_VOICE_INPUT_BYTES } from "../prompts.js";
export function realtimeEventIdentity(value) {
    if (!value || typeof value !== "object")
        return undefined;
    return boundedIdentifier(value["id"]);
}
function boundedIdentifier(id) {
    return typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 256 ? id : undefined;
}
export function realtimeEventDetails(callId, event, text, accepted) {
    const item = event["item"];
    const itemRecord = item && typeof item === "object" ? item : undefined;
    const itemId = realtimeEventIdentity(item) ?? boundedIdentifier(event["delegation_item_id"]);
    const turnId = realtimeEventIdentity(event["turn"]) ?? boundedIdentifier(itemRecord?.["user_bidi_turn_id"]);
    const handoffId = boundedIdentifier(itemRecord?.["handoff_id"]);
    const offset = event["offset_ms"];
    const turn = event["turn"];
    const record = turn && typeof turn === "object" ? turn : undefined;
    const role = record?.["role"];
    const start = record?.["start_ms"] ?? event["start_ms"];
    const end = record?.["end_ms"] ?? event["end_ms"];
    const transcript = text ?? boundedAssistantTranscript(record?.["transcript"]);
    return {
        callId,
        type: String(event["type"]),
        ...(itemId ? { itemId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(handoffId ? { handoffId } : {}),
        ...(role === "user" || role === "assistant" ? { role } : {}),
        ...(typeof offset === "number" && Number.isFinite(offset) ? { offsetMs: offset } : {}),
        ...(typeof start === "number" && Number.isFinite(start) ? { startMs: start } : {}),
        ...(typeof end === "number" && Number.isFinite(end) ? { endMs: end } : {}),
        ...(transcript ? { textHash: createHash("sha256").update(transcript).digest("hex") } : {}),
        accepted,
    };
}
export function boundedTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const input = value.trim();
    if (!input)
        return undefined;
    return Buffer.byteLength(input) > MAX_REALTIME_VOICE_INPUT_BYTES ? "oversized" : input;
}
export function transcriptItemText(value) {
    return value && typeof value === "object" ? value["text"] : undefined;
}
export function boundedAssistantTranscript(value) {
    if (typeof value !== "string")
        return undefined;
    const output = value.trim();
    if (!output)
        return undefined;
    return utf8Tail(output, MAX_REALTIME_VOICE_INPUT_BYTES - 32);
}
export function remoteError(event) {
    if (typeof event["message"] === "string")
        return event["message"];
    const error = event["error"];
    return error && typeof error === "object" && typeof error["message"] === "string" ? error["message"] : "Codex realtime error";
}
export function utf8Chunks(input, maxBytes) {
    const chunks = [];
    let current = "";
    for (const character of input) {
        if (Buffer.byteLength(current + character) > maxBytes && current) {
            chunks.push(current);
            current = character;
        }
        else
            current += character;
    }
    if (current)
        chunks.push(current);
    return chunks;
}
export function realtimePeerStateFailure(state) {
    if (state === "failed")
        return "Codex realtime connection failed";
    if (state === "closed")
        return "Codex realtime connection closed";
    return undefined;
}
function utf8Tail(value, maxBytes) {
    if (Buffer.byteLength(value) <= maxBytes)
        return value;
    let start = value.length;
    let bytes = 0;
    while (start > 0) {
        let characterStart = start - 1;
        const lastUnit = value.charCodeAt(characterStart);
        if (lastUnit >= 0xdc00 && lastUnit <= 0xdfff && characterStart > 0)
            characterStart--;
        const characterBytes = Buffer.byteLength(value.slice(characterStart, start));
        if (bytes + characterBytes > maxBytes)
            break;
        bytes += characterBytes;
        start = characterStart;
    }
    return value.slice(start);
}
