export const REALTIME_VOICE_PROMPT_CHANNEL = "@howaboua/pi-codex-conversion/realtime-voice-prompt/v1";
export const MAX_REALTIME_VOICE_PROMPT_BYTES = 8 * 1_024;
export function reportRealtimeVoicePrompt(pi, report) {
    const normalized = parseRealtimeVoicePrompt(report);
    if (!normalized)
        throw new Error("Invalid realtime voice prompt report");
    pi.events.emit(REALTIME_VOICE_PROMPT_CHANNEL, normalized);
}
export function parseRealtimeVoicePrompt(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    if (typeof record["id"] !== "string" ||
        typeof record["active"] !== "boolean" ||
        typeof record["prompt"] !== "string")
        return undefined;
    const id = record["id"].trim();
    const prompt = record["prompt"];
    if (id.length > 160 ||
        !prompt.trim() ||
        new TextEncoder().encode(prompt).byteLength > MAX_REALTIME_VOICE_PROMPT_BYTES)
        return undefined;
    return id ? { id, active: record["active"], prompt } : undefined;
}
