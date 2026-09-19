import { CODEX_VOICE_MODE_MESSAGE_TYPE, REALTIME_VOICE_MESSAGE_TYPE, } from "./message-types.js";
export function isVoiceContextExcludedMessage(message) {
    if (message.role !== "custom")
        return false;
    if (message.customType === REALTIME_VOICE_MESSAGE_TYPE)
        return true;
    return (message.customType === CODEX_VOICE_MODE_MESSAGE_TYPE &&
        (typeof message.content !== "string" ||
            !message.content.startsWith('<realtime_voice_session state="')));
}
