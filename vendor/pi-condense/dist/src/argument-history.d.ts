import { type ProtectionConfig } from "./protected.js";
import type { CapturedBatch } from "./types.js";
export declare const ARGUMENT_HISTORY = "context-prune-arguments";
export interface ArgumentHistory {
    version: 1;
    sourceIds: string[];
    fingerprints: string[];
    keys: string[];
    text: string;
}
/** Complete successful mutation groups only; leave the most recent interaction intact. */
export declare function argumentCandidates(entries: Array<{
    sourceEntry: any;
    messages: any[];
}>, protection: ProtectionConfig, existing: ArgumentHistory[]): Array<{
    group: ArgumentHistory;
    batch: CapturedBatch;
}>;
/** Stable projection: source mutation or newly protected paths restore original messages. */
export declare function projectArguments(messages: any[], groups: ArgumentHistory[], protection: ProtectionConfig): any[];
