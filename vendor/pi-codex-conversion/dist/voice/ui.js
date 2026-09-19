import { Box, Text } from "@earendil-works/pi-tui";
import { renderRealtimeConversationInput, renderRealtimeDelegation, } from "./prompts.js";
import { CODEX_VOICE_MODE_MESSAGE_TYPE, CODEX_VOICE_SETUP_MESSAGE_TYPE, REALTIME_DELEGATION_MESSAGE_TYPE, REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, REALTIME_VOICE_MESSAGE_TYPE, VOICE_CONTEXT_MESSAGE_TYPE, } from "./message-types.js";
export { CODEX_VOICE_MODE_MESSAGE_TYPE, REALTIME_DELEGATION_MESSAGE_TYPE, REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, REALTIME_VOICE_MESSAGE_TYPE, VOICE_CONTEXT_MESSAGE_TYPE, } from "./message-types.js";
export function realtimeVoiceMessage(input, route, transcriptDelta) {
    return {
        customType: route === "delegation"
            ? REALTIME_DELEGATION_MESSAGE_TYPE
            : REALTIME_VOICE_MESSAGE_TYPE,
        content: route === "delegation"
            ? renderRealtimeDelegation(input, transcriptDelta)
            : renderRealtimeConversationInput(input),
        display: route !== "delegation",
        details: { input, route },
    };
}
export function codexVoiceModeMessage(mode, state) {
    return {
        customType: CODEX_VOICE_MODE_MESSAGE_TYPE,
        content: modeStateContent(mode, state),
        display: true,
        details: { mode, state },
    };
}
export function codexVoiceSetupMessage(instructions) {
    return {
        customType: CODEX_VOICE_SETUP_MESSAGE_TYPE,
        content: instructions,
        display: true,
        details: { instructions },
    };
}
export function registerCodexVoiceRenderer(pi) {
    pi.registerMessageRenderer(REALTIME_VOICE_MESSAGE_TYPE, (message, _options, theme) => {
        const input = typeof message.details?.input === "string"
            ? message.details.input
            : "Voice request";
        return voiceBox(theme, "Realtime Voice", input);
    });
    pi.registerMessageRenderer(REALTIME_DELEGATION_MESSAGE_TYPE, (message, _options, theme) => {
        const input = typeof message.details?.input === "string"
            ? message.details.input
            : "Voice request";
        const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
        box.addChild(new Text(theme.fg("userMessageText", input), 0, 0));
        return box;
    });
    pi.registerEntryRenderer(REALTIME_VOICE_MESSAGE_TYPE, (entry, _options, theme) => {
        const input = typeof entry.data?.input === "string"
            ? entry.data.input
            : "Voice request";
        return voiceBox(theme, "Realtime Voice", input);
    });
    pi.registerEntryRenderer(REALTIME_DELEGATION_MESSAGE_TYPE, (entry, _options, theme) => {
        const input = typeof entry.data?.input === "string"
            ? entry.data.input
            : "Voice delegation unavailable.";
        const error = typeof entry.data?.error === "string"
            ? `\n\nNot sent: ${entry.data.error}`
            : "";
        return voiceBox(theme, "Voice delegation", `${input}${error}`);
    });
    pi.registerEntryRenderer(REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, (entry, _options, theme) => {
        const transcript = typeof entry.data?.transcript === "string"
            ? entry.data.transcript
            : "Voice transcript unavailable.";
        return voiceBox(theme, "You said", transcript);
    });
    pi.registerEntryRenderer(VOICE_CONTEXT_MESSAGE_TYPE, (entry, _options, theme) => {
        const summary = typeof entry.data?.summary === "string"
            ? entry.data.summary
            : "No voice context summary.";
        return voiceBox(theme, "Voice Context", summary);
    });
    pi.registerMessageRenderer(CODEX_VOICE_MODE_MESSAGE_TYPE, (message, _options, theme) => {
        const mode = message.details?.mode === "dictation" ? "dictation" : "realtime";
        const state = message.details?.state === "ended" ? "ended" : "started";
        return voiceBox(theme, mode === "dictation" ? "Codex Dictation" : "Realtime Voice", modeStateDisplay(mode, state));
    });
    pi.registerEntryRenderer(CODEX_VOICE_MODE_MESSAGE_TYPE, (entry, _options, theme) => {
        const mode = entry.data?.mode === "dictation" ? "dictation" : "realtime";
        const state = entry.data?.state === "ended" ? "ended" : "started";
        return voiceBox(theme, mode === "dictation" ? "Codex Dictation" : "Realtime Voice", modeStateDisplay(mode, state));
    });
    pi.registerMessageRenderer(CODEX_VOICE_SETUP_MESSAGE_TYPE, (message, _options, theme) => {
        const instructions = typeof message.details?.instructions === "string"
            ? message.details.instructions
            : typeof message.content === "string"
                ? message.content
                : "Codex voice audio setup is required.";
        return voiceBox(theme, "Codex Voice Setup", instructions);
    });
}
function voiceBox(theme, labelText, bodyText) {
    const label = theme.bold(theme.fg("customMessageLabel", labelText));
    const body = theme.fg("customMessageText", bodyText);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${label}\n${body}`, 0, 0));
    return box;
}
function modeStateContent(mode, state) {
    if (state === "ended") {
        return mode === "dictation"
            ? '<codex_voice_mode mode="dictation" state="ended">Dictation ended. Subsequent user messages are ordinary typed input unless another mode marker says otherwise.</codex_voice_mode>'
            : `<realtime_voice_session state="ended">
The realtime voice session has closed. This lifecycle event carries no task. Evaluate any subsequent transcript-tail context normally; it may contain an unhandled user request.

Resume normal conversation, tool use, and formatting appropriate for the task at hand.
</realtime_voice_session>`;
    }
    return mode === "dictation"
        ? '<codex_voice_mode mode="dictation" state="active">Dictation is active. User messages may contain speech-recognition errors or missing punctuation. Resolve obvious errors from context and clarify only material ambiguity.</codex_voice_mode>'
        : `<realtime_voice_session state="active">
A separate voice assistant is now conversing with the user. This lifecycle event carries no task. Handle any subsequent realtime_delegation as an ordinary authoritative user request.

The user may also send ordinary typed messages directly to Pi. Handle them normally; only realtime_delegation messages represent voice-agent delegation.

During longer delegated work, include brief user-facing progress text in assistant messages between tool calls. Keep everyone informed and up to date with what you're doing. Report meaningful progress or the next step; do not narrate routine commands.

Shape all replies to realtime delegations for spoken delivery. Prefer concise, natural language; include raw links, code, command lines, tables, or similarly visual detail only when the user specifically requests them.

Preserve the spoken flow. Do not invoke ask-questions tools or similar interactive handoffs unless the user specifically requests them. Ask necessary clarifying questions in ordinary assistant text instead.
</realtime_voice_session>`;
}
function modeStateDisplay(mode, state) {
    if (state === "ended")
        return mode === "dictation"
            ? "Ended · Subsequent prompts are ordinary typed input."
            : "Ended · The voice session has closed; any remaining transcript follows separately.";
    return mode === "dictation"
        ? "Active · Dictated prompts may contain recognition errors or missing punctuation."
        : "Active · A voice assistant is conversing with the user and may delegate work to Pi.";
}
