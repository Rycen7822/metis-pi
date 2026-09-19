import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexRealtimeConversation } from "./conversation/session.ts";
import type { CodexDictationSession } from "./dictation/session.ts";
import type { CodexVoiceMode } from "./ui.ts";
export declare const VOICE_STATUS_KEY = "codex-voice";
export type VoiceSession = CodexRealtimeConversation | CodexDictationSession;
export type VoiceState = {
    type: "idle";
} | {
    type: "reconnecting";
    session: CodexRealtimeConversation;
} | {
    type: "connecting";
    mode: "realtime";
    phase: "authorizing";
} | {
    type: "connecting";
    mode: "realtime";
    phase: "starting";
    session: CodexRealtimeConversation;
} | {
    type: "connecting";
    mode: "dictation";
    phase: "authorizing";
} | {
    type: "connecting";
    mode: "dictation";
    phase: "starting";
    session: CodexDictationSession;
} | {
    type: "conversation";
    session: CodexRealtimeConversation;
} | {
    type: "dictation";
    session: CodexDictationSession;
} | {
    type: "failed";
    message: string;
};
export declare function currentVoiceSession(state: VoiceState): VoiceSession | undefined;
export declare function voiceModeForState(state: Exclude<VoiceState, {
    type: "idle";
} | {
    type: "failed";
}>): CodexVoiceMode;
export declare function prepareRealtimeVoicePrompt(ctx: ExtensionContext): string | undefined;
export declare function renderVoiceStatus(ctx: ExtensionContext | undefined, status: string, muted: boolean, inputTooQuiet: boolean): void;
