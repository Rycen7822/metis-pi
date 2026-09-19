import type { RawData } from "ws";
import { decodeLanVoiceAudioCommand } from "./protocol.ts";
export declare const MAX_CONTROL_BYTES: number;
export type LanVoiceBrowserInput = {
    type: "audio";
    pcm: Buffer;
} | {
    type: "control";
    command: ReturnType<typeof decodeLanVoiceAudioCommand>;
};
export declare function decodeLanVoiceBrowserInput(data: RawData, isBinary: boolean): LanVoiceBrowserInput;
export declare function errorMessage(error: unknown): string;
