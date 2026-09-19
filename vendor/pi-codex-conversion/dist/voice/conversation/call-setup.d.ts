import type { CodexConversionConfig } from "../../adapter/activation/config.ts";
import type { RealtimeInitialMessageItem } from "../context.ts";
type RealtimeCallResult = {
    status: number;
    answer: string;
};
export type RealtimeCallSetup = (endpoint: string, headers: Headers, signal: AbortSignal, body: string, env?: Record<string, string>) => Promise<RealtimeCallResult>;
export declare function buildRealtimeCallRequest(sdp: string, config: CodexConversionConfig, instructions: string, initialItems?: RealtimeInitialMessageItem[]): {
    sdp: string;
    session: {
        initial_items?: RealtimeInitialMessageItem[];
        model: string;
        instructions: string;
        audio: {
            output: {
                voice: "juniper" | "maple" | "spruce" | "ember" | "vale" | "breeze" | "arbor" | "sol" | "cove";
            };
        };
        delegation: {
            type: string;
            ack_filler: boolean;
        };
    };
};
export declare const setupRealtimeCall: RealtimeCallSetup;
export {};
