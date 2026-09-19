export type LanVoiceAudioCommand = {
    type: "start";
    mode: "conversation" | "dictation";
} | {
    type: "mute";
    muted: boolean;
} | {
    type: "finish";
    draft: string;
    revision: number;
    selection: {
        start: number;
        end: number;
    };
} | {
    type: "release";
} | {
    type: "cancel";
};
export declare function decodeLanVoiceAudioCommand(value: unknown): LanVoiceAudioCommand;
