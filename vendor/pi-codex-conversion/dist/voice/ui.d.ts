import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { CODEX_VOICE_MODE_MESSAGE_TYPE, REALTIME_DELEGATION_MESSAGE_TYPE, REALTIME_USER_TRANSCRIPT_MESSAGE_TYPE, REALTIME_VOICE_MESSAGE_TYPE, VOICE_CONTEXT_MESSAGE_TYPE, } from "./message-types.ts";
export type CodexVoiceMode = "realtime" | "dictation";
export type CodexVoiceModeState = "started" | "ended";
export interface RealtimeVoiceMessageDetails {
    input: string;
    route: "conversation" | "delegation";
    error?: string | undefined;
}
export interface CodexVoiceModeMessageDetails {
    mode: CodexVoiceMode;
    state: CodexVoiceModeState;
}
export interface RealtimeUserTranscriptMessageDetails {
    transcript: string;
}
export declare function realtimeVoiceMessage(input: string, route: RealtimeVoiceMessageDetails["route"], transcriptDelta?: string): {
    customType: string;
    content: string;
    display: boolean;
    details: {
        input: string;
        route: "conversation" | "delegation";
    };
};
export declare function codexVoiceModeMessage(mode: CodexVoiceMode, state: CodexVoiceModeState): {
    customType: string;
    content: string;
    display: boolean;
    details: {
        mode: CodexVoiceMode;
        state: CodexVoiceModeState;
    };
};
export declare function codexVoiceSetupMessage(instructions: string): {
    customType: string;
    content: string;
    display: boolean;
    details: {
        instructions: string;
    };
};
export declare function registerCodexVoiceRenderer(pi: ExtensionAPI): void;
