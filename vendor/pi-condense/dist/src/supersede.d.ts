/**
 * Protected reads are never indexed, so nothing else in the pipeline ever
 * collapses a re-read of the same skill file. This module keeps only the
 * newest byte-identical successful protected read of the same range verbatim.
 */
export interface SupersededCandidate {
    toolCallId: string;
    path: string;
    timestamp: number | undefined;
    resultIndex: number;
    identity: string;
}
export interface SupersedeState {
    /** Earliest result timestamp the next render will rewrite anyway; 0 = cold cache, activate everything. */
    floor: number | undefined;
    /** occKey(toolCallId, resultTimestamp) of candidates whose stub has taken effect (session-sticky). */
    activated: Set<string>;
}
export declare function createSupersedeState(): SupersedeState;
export declare function lowerFloor(state: SupersedeState, t: number | undefined): void;
export declare function earliestResultTimestamp(toolCalls: readonly {
    resultTimestamp?: number;
}[]): number | undefined;
export declare function earliestChainStart(entries: readonly {
    startUserTimestamp: number;
}[]): number | undefined;
export declare function supersededStub(path: string): string;
export type IsProtectedFn = (toolName: string, args: unknown) => boolean;
export declare function findSuperseded(messages: any[], isProtected: IsProtectedFn): SupersededCandidate[];
/**
 * Phase 1b of pruneMessages. Reference-preserving when nothing is stubbed.
 * Consumes `state.floor` exactly once per call.
 */
export declare function applySupersede(messages: any[], state: SupersedeState, isProtected: IsProtectedFn): any[];
