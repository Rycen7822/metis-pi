export interface RealtimeVoiceEventDetails {
    callId: string;
    type: string;
    itemId?: string;
    turnId?: string;
    handoffId?: string;
    role?: "user" | "assistant";
    offsetMs?: number;
    startMs?: number;
    endMs?: number;
    textHash?: string;
    accepted: boolean;
}
export declare function realtimeEventIdentity(value: unknown): string | undefined;
export declare function realtimeEventDetails(callId: string, event: Record<string, unknown>, text: string | undefined, accepted: boolean): RealtimeVoiceEventDetails;
export declare function boundedTranscript(value: unknown): string | "oversized" | undefined;
export declare function transcriptItemText(value: unknown): unknown;
export declare function boundedAssistantTranscript(value: unknown): string | undefined;
export declare function remoteError(event: Record<string, unknown>): string;
export declare function utf8Chunks(input: string, maxBytes: number): string[];
export declare function realtimePeerStateFailure(state: string): string | undefined;
