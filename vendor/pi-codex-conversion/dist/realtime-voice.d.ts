import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare const REALTIME_VOICE_PROMPT_CHANNEL = "@howaboua/pi-codex-conversion/realtime-voice-prompt/v1";
export declare const MAX_REALTIME_VOICE_PROMPT_BYTES: number;
export interface RealtimeVoicePromptReport {
    id: string;
    active: boolean;
    prompt: string;
}
export declare function reportRealtimeVoicePrompt(pi: Pick<ExtensionAPI, "events">, report: RealtimeVoicePromptReport): void;
export declare function parseRealtimeVoicePrompt(value: unknown): RealtimeVoicePromptReport | undefined;
