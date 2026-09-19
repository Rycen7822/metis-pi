import { formatCodexVoicePromptSchemaMismatch, getProjectCodexVoiceSystemPromptPath, loadCodexVoiceSystemPrompt, prepareCodexVoiceSystemPrompt, } from "./system-prompt.js";
export const VOICE_STATUS_KEY = "codex-voice";
export function currentVoiceSession(state) {
    if (state.type === "conversation" || state.type === "dictation" || state.type === "reconnecting")
        return state.session;
    return state.type === "connecting" && state.phase === "starting" ? state.session : undefined;
}
export function voiceModeForState(state) {
    return state.type === "connecting"
        ? state.mode
        : state.type === "dictation" ? "dictation" : "realtime";
}
export function prepareRealtimeVoicePrompt(ctx) {
    try {
        const status = prepareCodexVoiceSystemPrompt();
        if (!status.current)
            ctx.ui.notify(formatCodexVoicePromptSchemaMismatch(status.currentSchemaVersion), "warning");
        return loadCodexVoiceSystemPrompt(undefined, ctx.isProjectTrusted() ? getProjectCodexVoiceSystemPromptPath(ctx.cwd) : undefined);
    }
    catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return undefined;
    }
}
export function renderVoiceStatus(ctx, status, muted, inputTooQuiet) {
    if (!ctx || !status)
        return;
    const mute = muted ? ctx.ui.theme.fg("warning", " · mic muted") : "";
    const level = !muted && inputTooQuiet ? ctx.ui.theme.fg("warning", " · mic too quiet") : "";
    ctx.ui.setStatus(VOICE_STATUS_KEY, `${ctx.ui.theme.fg("accent", `voice: ${status}`)}${mute}${level}`);
}
