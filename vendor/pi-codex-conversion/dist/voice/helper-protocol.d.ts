export type VoiceHelperCommand = {
    type: "list_devices";
} | {
    type: "start_v3";
    microphone?: string;
    speaker?: string;
} | {
    type: "start_v3_bridge";
} | {
    type: "set_input_muted";
    muted: boolean;
} | {
    type: "apply_answer";
    sdp: string;
} | {
    type: "start_dictation";
    microphone?: string;
} | {
    type: "send_data";
    message: unknown;
} | {
    type: "send_pcm";
    audio: string;
    sample_rate: 24_000;
    num_channels: 1;
} | {
    type: "stop";
} | {
    type: "shutdown";
};
export type VoiceHelperEvent = {
    type: "ready";
    version: number;
} | {
    type: "devices";
    inputs: VoiceDevice[];
    outputs: VoiceDevice[];
} | {
    type: "offer";
    sdp: string;
} | {
    type: "state";
    state: string;
} | {
    type: "data";
    message: unknown;
} | {
    type: "pcm";
    audio: string;
    sample_rate: number;
    num_channels: number;
} | {
    type: "error";
    message: string;
} | {
    type: "stopped";
};
export interface VoiceDevice {
    id: string;
    name: string;
    is_default: boolean;
}
export declare class BoundedJsonlReader {
    private readonly chunks;
    private readonly maxLineBytes;
    private readonly onLine;
    private readonly onOversized;
    private byteLength;
    private failed;
    constructor(maxLineBytes: number, onLine: (line: string) => void, onOversized: () => void);
    push(chunk: Buffer): void;
    end(): void;
    private append;
    private emitLine;
}
export declare function parseVoiceHelperEvent(value: unknown): VoiceHelperEvent;
